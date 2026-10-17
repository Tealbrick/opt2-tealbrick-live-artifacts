// Server-side sanitizer for agent documents (C238). It runs on EVERY agent document the app serves (owner preview and
// public link) and removes static markup that can reach the network in some browsers, which no header can stop:
// `<link rel=prerender>` and friends, `<base>`, `<meta http-equiv>`, `<portal>`, speculation rules, and any element that
// carries a URL other than `data:` or a relative one. Scripts stay ON in Live Artifacts (C167); what a script can do is the
// recorded residual R3 (SECURITY.md). A page WITHOUT script therefore reaches no network by static markup.
//
// Method: parse with parse5 (the WHATWG tokenizer and tree builder, scripting enabled, so every context switch is exact),
// walk the tree, remove or rewrite, serialize. No whole-document regexes. It FAILS CLOSED: any parse or serialize error, an
// oversize document, or a result that does not pass the verification pass (the output is parsed again and must contain
// nothing to remove) yields the fixed "cannot show this page" document.
//
// One module, one call site (`servedDocument`, called by the viewer): the shared SDK helper (miniapp-sdk 0.1.29,
// sanitizeAgentDocument) replaces this file when it ships.
import { createHash } from "node:crypto";
import { type DefaultTreeAdapterMap, defaultTreeAdapter, parse, serialize } from "parse5";

type Node = DefaultTreeAdapterMap["node"];
type Parent = DefaultTreeAdapterMap["parentNode"];
type El = DefaultTreeAdapterMap["element"];
type Txt = DefaultTreeAdapterMap["textNode"];

/** The document we serve when a page cannot be made safe. Fixed text, no agent content. */
export const BLOCKED_DOCUMENT = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page not shown</title></head><body style="font:15px/1.5 system-ui,sans-serif;margin:24px"><p>This page cannot be shown.</p><p>Ask the owner of the page to check it.</p></body></html>`;

/** Deepest element nesting we parse. The HTML tree builder scans its open elements for many start tags, so a page of
 *  thousands of unclosed `<div>` costs seconds (quadratic). Real pages stay far below this; deeper pages fail closed. */
export const SANITIZE_MAX_DEPTH = 256;

/** Larger than the 256 KiB version limit with room to spare; the perf test uses a 1 MiB page. Above this: blocked. */
export const SANITIZE_MAX_BYTES = 4 * 1024 * 1024;

// ───────────────────────────────────────────────────────────────────────── URLs

/** `ok` = a `data:` URL or a relative reference (path, query, fragment, empty); `external` = anything else: a scheme other
 *  than data (http, https, javascript, blob, about, mailto, ftp …), a protocol-relative `//host`, or a backslash form. The
 *  value is the DECODED attribute value (the parser already resolved entities); tabs and newlines are removed anywhere and
 *  leading/trailing control characters and spaces are trimmed, as the URL parser does. */
export function classifyUrl(raw: string): "ok" | "external" {
  let start = 0;
  let end = raw.length;
  while (start < end && raw.charCodeAt(start) <= 32) start++;
  while (end > start && raw.charCodeAt(end - 1) <= 32) end--;
  const s = raw.slice(start, end).replace(/[\t\n\r]/g, "");
  if (s === "") return "ok";
  if (/^[\\/]{2}/.test(s)) return "external"; // //host, \\host, /\host, \/host (the URL parser reads \ as /)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return /^data:/i.test(s) ? "ok" : "external";
  return "ok";
}

/** URLs of an `srcset` value, parsed as the HTML spec does (a `data:` URL may hold commas). */
export function srcsetUrls(value: string): string[] {
  const urls: string[] = [];
  const n = value.length;
  let p = 0;
  const ws = (c: number) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
  while (p < n) {
    while (p < n && (ws(value.charCodeAt(p)) || value.charCodeAt(p) === 44)) p++;
    if (p >= n) break;
    const start = p;
    while (p < n && !ws(value.charCodeAt(p))) p++;
    const url = value.slice(start, p);
    if (url.endsWith(",")) {
      urls.push(url.replace(/,+$/, ""));
      continue;
    }
    urls.push(url);
    let depth = 0;
    while (p < n) {
      const c = value.charCodeAt(p++);
      if (c === 40) depth++;
      else if (c === 41 && depth > 0) depth--;
      else if (c === 44 && depth === 0) break;
    }
  }
  return urls;
}

/** Attributes whose value is a URL that a browser may load or navigate to. */
const URL_ATTRS = new Set([
  "src", "href", "xlink:href", "srcset", "imagesrcset", "action", "formaction", "ping", "poster", "background", "data",
  "lowsrc", "dynsrc", "longdesc", "manifest", "codebase", "icon", "profile",
]);
/** (element, attribute) pairs that only navigate on a user action: a bad value removes the ATTRIBUTE, the element stays. */
const LINK_ATTRS: Record<string, ReadonlySet<string>> = {
  a: new Set(["href", "xlink:href", "ping"]),
  area: new Set(["href", "ping"]),
  form: new Set(["action"]),
  button: new Set(["formaction"]),
  input: new Set(["formaction"]),
};
/** Elements whose job is to load the address: when it is outside they are removed, with their content. On any other element
 *  (body, table, td, math, svg gradients …) only the attribute goes, so a stray `background=` never takes a whole page with it. */
const LOADERS = new Set(["img", "image", "video", "audio", "source", "track", "input", "script", "use", "feimage", "tref", "font-face-uri", "cursor", "bgsound", "frame", "keygen"]);
/** Attributes that hold CSS (a `style` attribute and the SVG presentation attributes that accept `url()`). */
const CSS_ATTRS = new Set(["style", "fill", "stroke", "filter", "mask", "clip-path", "marker", "marker-start", "marker-mid", "marker-end", "cursor", "clip", "list-style-image", "background-image", "mask-image"]);
/** Elements removed with everything in them, whatever their attributes. */
const REMOVE_ELEMENTS = new Set(["link", "base", "portal", "iframe", "frame", "frameset", "object", "embed", "applet", "noscript", "noembed", "noframes", "isindex"]);
const SMIL = new Set(["set", "animate", "animatetransform", "animatemotion", "animatecolor"]);

function urlBad(attr: string, value: string): boolean {
  if (attr === "srcset" || attr === "imagesrcset") return srcsetUrls(value).some((u) => classifyUrl(u) !== "ok");
  if (attr === "ping") return value.split(/[\t\n\f\r ]+/).some((u) => u !== "" && classifyUrl(u) !== "ok");
  return classifyUrl(value) !== "ok";
}

// ───────────────────────────────────────────────────────────────────────── CSS

const CSS_IMAGE_FUNCS = new Set(["image-set", "-webkit-image-set", "cross-fade", "-webkit-cross-fade", "image", "src"]);
const CSS_SUBSTITUTIONS = new Set(["var", "attr", "env", "if", "first-valid"]);
const BLOCKED_FUNC = "x-blocked";

export function unescapeCss(s: string): string {
  if (!s.includes("\\")) return s;
  return s.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n\f]?|([\s\S]))/g, (_m, hex?: string, ch?: string) => {
    if (hex !== undefined) {
      const cp = Number.parseInt(hex, 16);
      return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? "�" : String.fromCodePoint(cp);
    }
    return ch === "\n" ? "" : (ch ?? "");
  });
}
const isNameChar = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45 || c >= 128;
const isNameStart = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 128;

/** End index of an identifier starting at `i` (escapes included). */
function identEnd(css: string, i: number): number {
  const n = css.length;
  while (i < n) {
    const c = css.charCodeAt(i);
    if (isNameChar(c)) i++;
    else if (c === 92 && i + 1 < n && css.charCodeAt(i + 1) !== 10) {
      i++; // the backslash
      let h = 0;
      while (h < 6 && i < n && /[0-9a-fA-F]/.test(css[i] as string)) {
        i++;
        h++;
      }
      if (h === 0) i++; // escaped literal character
      else if (i < n && /[ \t\n\f]/.test(css[i] as string)) i++; // the one whitespace that ends a hex escape
    } else break;
  }
  return i;
}
function identStartsAt(css: string, i: number): boolean {
  const c = css.charCodeAt(i);
  if (isNameStart(c)) return true;
  if (c === 92) return i + 1 < css.length && css.charCodeAt(i + 1) !== 10;
  if (c === 45) {
    const d = css.charCodeAt(i + 1);
    return isNameStart(d) || d === 45 || (d === 92 && css.charCodeAt(i + 2) !== 10);
  }
  return false;
}
/** End of a string token starting at the quote at `i`. */
function stringEnd(css: string, i: number): number {
  const q = css.charCodeAt(i);
  const n = css.length;
  let p = i + 1;
  while (p < n) {
    const c = css.charCodeAt(p);
    if (c === 92) p += 2;
    else if (c === q) return p + 1;
    else if (c === 10) return p; // bad string: ends before the newline
    else p++;
  }
  return n;
}
/** End of a balanced `( … )` whose opening paren is at `open` (index after the close paren), skipping strings. */
function parenEnd(css: string, open: number): number {
  const n = css.length;
  let depth = 0;
  let p = open;
  while (p < n) {
    const c = css.charCodeAt(p);
    if (c === 34 || c === 39) p = stringEnd(css, p);
    else if (c === 92) p += 2;
    else if (c === 47 && css.charCodeAt(p + 1) === 42) {
      const e = css.indexOf("*/", p + 2);
      p = e < 0 ? n : e + 2;
    } else {
      if (c === 40) depth++;
      else if (c === 41 && --depth === 0) return p + 1;
      p++;
    }
  }
  return n;
}

export interface CssResult {
  text: string;
  /** how many urls, imports and substitution tricks were neutralised */
  blocked: number;
}
interface Edit {
  from: number;
  to: number;
  repl: string;
}

/** Neutralise every way CSS can load a URL that is not `data:` or relative: `url()` (any spelling, escapes decoded),
 *  `@import` (dropped), strings inside `image-set()`/`src()`/`cross-fade()`, `var()`/`attr()` inside those, and the typed
 *  `attr(… type(<url>))`. An outside URL becomes `url("data:,")`. Linear time. */
export function sanitizeCss(css: string): CssResult {
  const n = css.length;
  const edits: Edit[] = [];
  const stack: { img: boolean; from: number; to: number; renamed: boolean }[] = [];
  const imgOpen: { from: number; to: number; renamed: boolean }[] = [];
  const rename = (e: { from: number; to: number; renamed: boolean }) => {
    if (e.renamed) return;
    e.renamed = true;
    edits.push({ from: e.from, to: e.to, repl: `${BLOCKED_FUNC}(` });
  };
  let i = 0;
  while (i < n) {
    const c = css.charCodeAt(i);
    if (c === 47 && css.charCodeAt(i + 1) === 42) {
      const e = css.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === 34 || c === 39) {
      const end = stringEnd(css, i);
      if (imgOpen.length > 0) {
        const value = unescapeCss(css.slice(i + 1, css.charCodeAt(end - 1) === c && end - 1 > i ? end - 1 : end));
        if (classifyUrl(value) !== "ok") edits.push({ from: i, to: end, repl: '"data:,"' });
      }
      i = end;
      continue;
    }
    if (c === 64) {
      const end = identEnd(css, i + 1);
      if (unescapeCss(css.slice(i + 1, end)).toLowerCase() === "import") {
        // drop the whole statement: to the next `;` outside strings and parens, or the next `}`
        let p = end;
        while (p < n) {
          const d = css.charCodeAt(p);
          if (d === 34 || d === 39) p = stringEnd(css, p);
          else if (d === 40) p = parenEnd(css, p);
          else if (d === 92) p += 2;
          else if (d === 59) {
            p++;
            break;
          } else if (d === 125) break;
          else p++;
        }
        edits.push({ from: i, to: Math.min(p, n), repl: " " });
        i = Math.min(p, n);
        continue;
      }
      i = end;
      continue;
    }
    if (c === 35) {
      i = identEnd(css, i + 1); // hash token: `#url(` is not a function
      continue;
    }
    if (identStartsAt(css, i)) {
      const end = identEnd(css, i);
      if (css.charCodeAt(end) === 40) {
        const name = unescapeCss(css.slice(i, end)).toLowerCase();
        if (name === "url") {
          // `url(` + optional space + a quote is a function with a string; otherwise an unquoted url token
          let p = end + 1;
          while (p < n && /[ \t\n\f]/.test(css[p] as string)) p++;
          let value: string;
          let close: number;
          if (css.charCodeAt(p) === 34 || css.charCodeAt(p) === 39) {
            const se = stringEnd(css, p);
            value = unescapeCss(css.slice(p + 1, css.charCodeAt(se - 1) === css.charCodeAt(p) && se - 1 > p ? se - 1 : se));
            close = parenEnd(css, end);
          } else {
            let q = p;
            while (q < n && css.charCodeAt(q) !== 41) q += css.charCodeAt(q) === 92 ? 2 : 1;
            value = unescapeCss(css.slice(p, Math.min(q, n)).trim());
            close = Math.min(q + 1, n);
          }
          if (classifyUrl(value) !== "ok") edits.push({ from: i, to: close, repl: 'url("data:,")' });
          i = close;
          continue;
        }
        const isImg = CSS_IMAGE_FUNCS.has(name);
        const entry = { img: isImg, from: i, to: end + 1, renamed: false };
        if (CSS_SUBSTITUTIONS.has(name)) {
          for (const o of imgOpen) rename(o);
          imgOpen.length = 0;
          if (name === "attr") {
            // advanced attr(): `attr(data-x type(<url>))` builds a URL from an attribute; read the arguments (bounded)
            const args = css.slice(end + 1, end + 1025);
            const close = args.indexOf(")");
            if (close < 0 || /url|src/i.test(unescapeCss(args.slice(0, close)))) rename(entry);
          }
        }
        stack.push(entry);
        if (isImg) imgOpen.push(entry);
        i = end + 1;
        continue;
      }
      i = end;
      continue;
    }
    if (c === 40) {
      stack.push({ img: false, from: i, to: i, renamed: false });
      i++;
      continue;
    }
    if (c === 41) {
      const top = stack.pop();
      if (top && imgOpen[imgOpen.length - 1] === top) imgOpen.pop();
      i++;
      continue;
    }
    if (c === 92) {
      i += 2;
      continue;
    }
    i++;
  }
  if (edits.length === 0) return { text: css, blocked: 0 };
  edits.sort((a, b) => a.from - b.from);
  const parts: string[] = [];
  let last = 0;
  for (const e of edits) {
    if (e.from < last) continue; // overlapping edit (inside an already replaced span)
    parts.push(css.slice(last, e.from), e.repl);
    last = e.to;
  }
  parts.push(css.slice(last));
  return { text: parts.join(""), blocked: edits.length };
}

// ───────────────────────────────────────────────────────────────────────── tree

export type Findings = Map<string, number>;
const note = (f: Findings, key: string): void => void f.set(key, (f.get(key) ?? 0) + 1);

const attrKey = (a: { name: string; prefix?: string | undefined }): string => (a.prefix ? `${a.prefix}:${a.name}` : a.name).toLowerCase();
const textOf = (el: El): string | null => {
  let s = "";
  for (const k of el.childNodes) {
    if (k.nodeName !== "#text") return null;
    s += (k as Txt).value;
  }
  return s;
};

/** Decide about one element and (when `mutate`) rewrite its attributes. Returns true to remove it with its subtree. */
function inspectElement(el: El, mutate: boolean, f: Findings): boolean {
  const tag = el.tagName.toLowerCase();
  if (REMOVE_ELEMENTS.has(tag)) {
    note(f, tag === "link" || tag === "base" || tag === "portal" ? tag : "embedded-content");
    return true;
  }
  const attrs = el.attrs;
  const keep: typeof attrs = [];
  let remove = false;
  let rewritten = false;
  for (const a of attrs) {
    const key = attrKey(a);
    if (key === "http-equiv" && tag === "meta") {
      note(f, "meta-http-equiv");
      return true;
    }
    if (key === "xml:base") {
      note(f, "xml-base");
      rewritten = true;
      continue;
    }
    if (URL_ATTRS.has(key) && urlBad(key, a.value)) {
      if (LINK_ATTRS[tag]?.has(key)) {
        note(f, "link-attribute");
        rewritten = true;
        continue; // the element and its text stay; the address goes
      }
      if (LOADERS.has(tag)) {
        note(f, "url-attribute");
        remove = true;
        break;
      }
      note(f, "url-attribute-dropped");
      rewritten = true;
      continue;
    }
    if (CSS_ATTRS.has(key)) {
      const r = sanitizeCss(a.value);
      if (r.blocked > 0) {
        note(f, "css-url");
        rewritten = true;
        keep.push({ ...a, value: r.text });
        continue;
      }
    }
    keep.push(a);
  }
  if (remove) return true;
  if (tag === "script") {
    const type = el.attrs.find((a) => attrKey(a) === "type")?.value.trim().toLowerCase();
    if (type === "speculationrules") {
      note(f, "speculation-rules");
      return true;
    }
  }
  if (SMIL.has(tag)) {
    const target = (el.attrs.find((a) => attrKey(a) === "attributename")?.value ?? "").trim().toLowerCase();
    const values = ["to", "from", "by", "values"].flatMap((n) => (el.attrs.find((a) => attrKey(a) === n)?.value ?? "").split(";"));
    if (URL_ATTRS.has(target) ? values.some((v) => v.trim() !== "" && urlBad("href", v)) : values.some((v) => sanitizeCss(v).blocked > 0)) {
      note(f, "smil-url");
      return true;
    }
  }
  if (tag === "style") {
    const css = textOf(el);
    if (css === null) {
      note(f, "style-with-markup");
      return true;
    }
    const r = sanitizeCss(css);
    if (r.blocked > 0) {
      note(f, "css-url");
      if (mutate) for (const k of el.childNodes) (k as Txt).value = "";
      if (mutate && el.childNodes[0]) (el.childNodes[0] as Txt).value = r.text;
    }
  }
  if (rewritten && mutate) el.attrs = keep;
  return false;
}

/** Walk a tree. With `mutate` it removes and rewrites; without it only counts what it WOULD change (verification). */
function walk(root: Parent, mutate: boolean, f: Findings): void {
  const stack: Parent[] = [root];
  while (stack.length > 0) {
    const parent = stack.pop() as Parent;
    const kids = parent.childNodes as Node[];
    let removed: Set<Node> | null = null;
    for (const child of kids) {
      let drop = false;
      if (child.nodeName === "#comment") drop = true; // inert, but conditional comments and bogus comments are noise
      else if (child.nodeName !== "#text" && child.nodeName !== "#documentType") drop = inspectElement(child as El, mutate, f);
      if (drop) {
        if (removed === null) removed = new Set();
        removed.add(child);
        continue;
      }
      if ("childNodes" in child && child.nodeName !== "#text") {
        stack.push(child as Parent);
        const content = (child as unknown as { content?: Parent }).content;
        if (content) stack.push(content); // <template> keeps its tree in .content
      }
    }
    if (removed && mutate) (parent as { childNodes: Node[] }).childNodes = kids.filter((k) => !removed?.has(k));
  }
}
/** Comments are removed silently; they are not security findings. */
const securityCount = (f: Findings): number => [...f.values()].reduce((a, b) => a + b, 0);

/** The default tree adapter, plus a depth check on every insertion (parse5 calls these as it builds the tree). */
const depthOf = new WeakMap<object, number>();
const boundedAdapter: typeof defaultTreeAdapter = {
  ...defaultTreeAdapter,
  appendChild(parent, child) {
    const d = (depthOf.get(parent) ?? 0) + 1;
    if (d > SANITIZE_MAX_DEPTH) throw new Error("document nests too deeply");
    depthOf.set(child, d);
    defaultTreeAdapter.appendChild(parent, child);
  },
  setTemplateContent(template, content) {
    depthOf.set(content, depthOf.get(template) ?? 0);
    defaultTreeAdapter.setTemplateContent(template, content);
  },
  insertBefore(parent, child, reference) {
    const d = (depthOf.get(parent) ?? 0) + 1;
    if (d > SANITIZE_MAX_DEPTH) throw new Error("document nests too deeply");
    depthOf.set(child, d);
    defaultTreeAdapter.insertBefore(parent, child, reference);
  },
};
const parseBounded = (html: string) => parse(html, { scriptingEnabled: true, treeAdapter: boundedAdapter });

export interface Sanitized {
  html: string;
  /** what was removed or rewritten, by rule */
  findings: Record<string, number>;
}

/** Sanitize one agent document. Throws on any failure; use `servedDocument` to fail closed. */
export function sanitizeHtml(input: string): Sanitized {
  if (input.length > SANITIZE_MAX_BYTES) throw new Error("document too large to sanitize");
  const f: Findings = new Map();
  const doc = parseBounded(input);
  walk(doc, true, f);
  const html = serialize(doc);
  // Verification: the browser parses OUR output. It must contain nothing the sanitizer would still change.
  const again: Findings = new Map();
  walk(parseBounded(html), false, again);
  if (securityCount(again) > 0) throw new Error(`sanitized output is not stable: ${[...again.keys()].join(",")}`);
  return { html, findings: Object.fromEntries(f) };
}

// Sanitizing is deterministic, so the result is cached by the digest of the input (a viewer polls and reloads).
const CACHE_MAX_ENTRIES = 16;
const CACHE_MAX_BYTES = 8 * 1024 * 1024;
const cache = new Map<string, string>();
let cacheBytes = 0;
export function clearSanitizeCache(): void {
  cache.clear();
  cacheBytes = 0;
}

/** THE call site for a served document: sanitized HTML, or the fixed "cannot show this page" document when anything fails. */
export function servedDocument(html: string): string {
  try {
    const key = createHash("sha256").update(html, "utf8").digest("hex");
    const hit = cache.get(key);
    if (hit !== undefined) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const out = sanitizeHtml(html).html;
    if (out.length * 2 <= CACHE_MAX_BYTES) {
      cache.set(key, out);
      cacheBytes += out.length;
      while (cache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES / 2) {
        const oldest = cache.keys().next().value as string;
        cacheBytes -= cache.get(oldest)?.length ?? 0;
        cache.delete(oldest);
      }
    }
    return out;
  } catch {
    return BLOCKED_DOCUMENT;
  }
}
