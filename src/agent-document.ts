// Agent documents (C238, C239): the app's one adapter over the SDK sanitizer (`sanitizeAgentDocument`, miniapp-sdk 0.1.31).
// The SDK owns the rules (AGENT_DOCUMENT_RULES, shared corpus with Creative): it parses with parse5, removes everything that can
// reach the network or the top window by static markup (link, base, meta http-equiv, forms, frames, speculation rules, URL
// attributes other than a fragment, a raster data: image or a path under ASSET_PREFIX, CSS url()/image-set()/@import), and fails
// closed to a fixed inert page. Its precheck counts tags and attributes over the WHOLE source before any parse, so the bomb
// shapes of the S6/S7 re-checks are refused in milliseconds.
// Scripts stay ON in Live Artifacts (C167); what a script can do is the recorded residual R3 (SECURITY.md).
//
// Here: the two renders of a version (scripts allowed, and the scriptless render of C239), what is stored with a version at
// write time, the serve-time fallback for rows written by an older rule set, and the data inlined into a scriptless page.
import { createHash } from "node:crypto";
import { AGENT_DOCUMENT_RULES } from "@opt2-tealbrick/manifest";
import { AGENT_DOCUMENT_UNAVAILABLE_HTML, type AgentDocumentDeps, fillTextSlots, type SanitizeAgentDocumentResult, sanitizeAgentDocument } from "@opt2-tealbrick/miniapp-sdk";
import { defaultTreeAdapter, parse } from "parse5";

/** The version of the sanitizer's RULES. Raise it with every change that can alter an output; a stored row with an older version
 *  is sanitized again at serve time. (1 = the first release; 2 = S6; 3 = the SDK sanitizer, S8; 4 = S8 parse bounds; rows from
 *  before the column: 0.) */
export const SANITIZER_VERSION = 4;

/** Where the app serves its own assets on the views origin (`/v/live-artifacts/_s/…`, viewer.ts). The SDK keeps URLs under it.
 *  The document CSPs still allow no script or image from there (img-src data: only), so such a URL loads nothing. */
export const ASSET_PREFIX = "/v/live-artifacts/_s/";

/** The page served when a document cannot be made safe: the SDK's fixed inert page (no agent content, no script). */
export const BLOCKED_DOCUMENT = AGENT_DOCUMENT_UNAVAILABLE_HTML;

export interface Served {
  html: string;
  /** the SANITIZED page can run script (a script element of any type, or an inline handler): decided by the SDK from its own
   *  output, never from anything the agent says. With `allowScripts: false` the scripts are gone and this says what the page had. */
  runsScripts: boolean;
}
export interface RenderOptions {
  /** false: the scriptless render of a public link (every script and inline handler removed) */
  allowScripts?: boolean;
}

// INTERIM (S8, until the SDK bounds its own parse; miniapp-sdk 0.1.33, C259): the SDK 0.1.31 checks its caps on the SOURCE and
// AGENT_DOCUMENT_RULES.maxDepth only AFTER parse5 has built the tree, and the tree builder can do far more work than the source
// shows. Every parse the SDK makes (the first pass, both verification passes, fillTextSlots) goes through this parse5 with a
// tree adapter that bounds the parse WHILE it runs; past a bound it throws and the SDK fails closed. The rules stay the SDK's;
// these bounds mirror the 0.1.33 ones:
// - depth: each insert records the parent's depth + 1, past maxDepth + 8 it throws (60,000 unclosed <div> cost ~10 s);
// - copied attributes: an element whose attribute list an earlier element already used is a copy made by the parser (a
//   formatting element re-opened, an adoption agency clone) and is charged attrs² against PARSE_ATTRIBUTE_BUDGET
//   (`<p><b a0..a255>` + `<p>x` × 20,000 = 79 KB gave 39 MB in 15 s);
// - <html>/<body> attribute merging (adoptAttributes): an incremental name set (parse5 rebuilds one per call: quadratic), the
//   element capped at PARSE_MAX_ATTRIBUTES, its growth charged against the same budget (`<html z0><html z1>…` × 30,000 = 26 s);
// - element count: at most PARSE_MAX_ELEMENTS created per parse.
// Outside the parse, `sdk()` refuses an output longer than max(4 × input, input + 1 MiB). `deps.parse` is the SDK's test seam;
// drop all of this when the app pins miniapp-sdk 0.1.33.
const PARSE_MAX_DEPTH = AGENT_DOCUMENT_RULES.maxDepth + 8;
export const PARSE_MAX_ATTRIBUTES = 2048;
export const PARSE_ATTRIBUTE_BUDGET = 4_194_304;
export const PARSE_MAX_ELEMENTS = 2 * AGENT_DOCUMENT_RULES.maxTags;
export const maxOutputLength = (n: number): number => Math.max(4 * n, n + 1024 * 1024);

type Adapter = typeof defaultTreeAdapter;
type AdapterElement = Parameters<Adapter["adoptAttributes"]>[0];
function boundedAdapter(): Adapter {
  const depthOf = new WeakMap<object, number>();
  const usedAttrs = new WeakSet<object>();
  const names = new WeakMap<object, Set<string>>();
  let left = PARSE_ATTRIBUTE_BUDGET;
  let elements = 0;
  const over = (what: string): never => {
    throw new Error(`document over a parse bound: ${what}`);
  };
  const charge = (cost: number): void => {
    left -= cost;
    if (left < 0) over("attributes copied by the parser");
  };
  const setDepth = (node: object, d: number): void => {
    if (d > PARSE_MAX_DEPTH) over("nests too deeply");
    depthOf.set(node, d);
    const content = (node as { content?: object }).content; // a <template> keeps its children one level below it
    if (content) depthOf.set(content, d + 1);
  };
  return {
    ...defaultTreeAdapter,
    createElement(tagName, namespaceURI, attrs) {
      if (++elements > PARSE_MAX_ELEMENTS) over("too many elements");
      if (usedAttrs.has(attrs)) {
        if (attrs.length > PARSE_MAX_ATTRIBUTES) over("too many attributes");
        charge(attrs.length * attrs.length);
      } else usedAttrs.add(attrs);
      return defaultTreeAdapter.createElement(tagName, namespaceURI, attrs);
    },
    appendChild(parent, child) {
      setDepth(child, (depthOf.get(parent) ?? 0) + 1);
      defaultTreeAdapter.appendChild(parent, child);
    },
    insertBefore(parent, child, reference) {
      setDepth(child, (depthOf.get(parent) ?? 0) + 1);
      defaultTreeAdapter.insertBefore(parent, child, reference);
    },
    setTemplateContent(template, content) {
      depthOf.set(content, (depthOf.get(template) ?? 0) + 1);
      defaultTreeAdapter.setTemplateContent(template, content);
    },
    adoptAttributes(recipient: AdapterElement, attrs) {
      let set = names.get(recipient);
      if (!set) {
        set = new Set(recipient.attrs.map((a) => a.name));
        names.set(recipient, set);
      }
      const before = recipient.attrs.length;
      for (const a of attrs) {
        if (set.has(a.name)) continue;
        set.add(a.name);
        recipient.attrs.push(a);
      }
      const after = recipient.attrs.length;
      if (after > PARSE_MAX_ATTRIBUTES) over("too many attributes");
      charge(after * after - before * before);
    },
  };
}
const BOUNDED: AgentDocumentDeps = { parse: ((html: string, options?: object) => parse(html, { ...options, treeAdapter: boundedAdapter() })) as typeof parse };

const sdk = (input: string, allowScripts: boolean): SanitizeAgentDocumentResult => {
  const r = sanitizeAgentDocument(input, { allowScripts, assetPrefix: ASSET_PREFIX }, BOUNDED);
  return r.ok && r.html.length > maxOutputLength(input.length) ? { ok: false, html: BLOCKED_DOCUMENT, runsScripts: false, removed: [] } : r;
};
const unservable = (): Error => new Error("the page is over the limits or cannot be read");

/** Sanitize one agent document. Throws when the SDK fails closed (over the caps, a parse failure); `servedDocumentInfo` maps that
 *  to the fixed page. */
export function sanitizeHtml(input: string, opts: RenderOptions = {}): Served {
  const full = sdk(input, true);
  if (!full.ok) throw unservable();
  if (opts.allowScripts !== false || !full.runsScripts) return { html: full.html, runsScripts: full.runsScripts };
  const plain = sdk(input, false);
  if (!plain.ok) throw unservable();
  return { html: plain.html, runsScripts: true };
}

// Sanitizing is deterministic, so a serve-time result is cached by the digest of the input and the mode (a viewer polls and
// reloads). Only rows without a stored result (older rule set, restored rows) reach this.
const CACHE_MAX_ENTRIES = 16;
const CACHE_MAX_BYTES = 8 * 1024 * 1024;
const cache = new Map<string, Served>();
let cacheBytes = 0;
export function clearSanitizeCache(): void {
  cache.clear();
  cacheBytes = 0;
}

/** Everything sanitizing a version produces, stored with it when it is written (throws when the page cannot be served). */
export function sanitizeForStore(html: string): { full: Buffer; runsScripts: boolean; plain: Buffer | null } {
  const full = sdk(html, true);
  if (!full.ok) throw unservable();
  let plain: Buffer | null = null;
  if (full.runsScripts) {
    const p = sdk(html, false);
    if (!p.ok) throw unservable();
    plain = Buffer.from(p.html, "utf8");
  }
  return { full: Buffer.from(full.html, "utf8"), runsScripts: full.runsScripts, plain };
}
const bytesText = (b: unknown): string => Buffer.from(b as Uint8Array).toString("utf8");
const isStored = (row: Record<string, unknown>): boolean =>
  row.served_html !== null && row.served_html !== undefined && row.served_runs_scripts !== null && row.served_runs_scripts !== undefined && Number(row.sanitizer_version ?? 0) === SANITIZER_VERSION;

/** The sanitized document of a stored version, scripts allowed, and whether it runs scripts: the result stored when the version
 *  was written, else (an older row, a restore) sanitized now. Fails closed to the fixed document (no scripts). */
export function versionServed(row: Record<string, unknown>): Served {
  if (isStored(row)) return { html: bytesText(row.served_html), runsScripts: Number(row.served_runs_scripts) === 1 };
  return servedDocumentInfo(bytesText(row.html));
}
/** The scriptless variant of a stored version (the page itself when it runs no scripts). */
export function versionPlain(row: Record<string, unknown>): string {
  if (isStored(row)) {
    if (Number(row.served_runs_scripts) !== 1) return bytesText(row.served_html);
    if (row.served_plain_html !== null && row.served_plain_html !== undefined) return bytesText(row.served_plain_html);
  }
  return servedDocumentInfo(bytesText(row.html), { allowScripts: false }).html;
}

/** THE serve-time call: the sanitized document and whether it runs scripts, or the fixed document (no scripts) when anything
 *  fails. `allowScripts: false` is the scriptless render. */
export function servedDocumentInfo(html: string, opts: RenderOptions = {}): Served {
  try {
    const mode = opts.allowScripts === false ? "n" : "s";
    const key = `${mode}:${createHash("sha256").update(html, "utf8").digest("hex")}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const out = sanitizeHtml(html, opts);
    if (out.html.length * 2 <= CACHE_MAX_BYTES) {
      cache.set(key, out);
      cacheBytes += out.html.length;
      while (cache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES / 2) {
        const oldest = cache.keys().next().value as string;
        cacheBytes -= cache.get(oldest)?.html.length ?? 0;
        cache.delete(oldest);
      }
    }
    return out;
  } catch {
    return { html: BLOCKED_DOCUMENT, runsScripts: false };
  }
}
/** The sanitized document with scripts allowed (the owner's view and the pages that may run scripts). */
export const servedDocument = (html: string): string => servedDocumentInfo(html).html;

// ───────────────────────────────────────────────────────────────────────── data inlined into a scriptless page

/** The attribute that binds an element's text to pushed data in a page without script: `data-tb-text="key.path.0.name"` (the
 *  SDK's text slot). */
export const BIND_ATTR = "data-tb-text";
const BIND_MAX_CHARS = 2000;
/** All inlined data of one response, counted as SERVED (escaped) bytes. Past it the slots of one key get BIND_CUT_MARKER and
 *  the later ones nothing: a response carries at most this plus BIND_MARKER_MAX_BYTES. (The SDK fills every slot of a key with
 *  the same value, so the cut is per key, in source order, and a key shown in n slots costs n times its value.) */
export const BIND_MAX_TOTAL_BYTES = 256 * 1024;
export const BIND_CUT_MARKER = "[data cut: too much for one page]";
const BIND_MARKER_MAX_BYTES = 4 * 1024;

function lookup(values: Record<string, unknown>, path: string): unknown {
  let cur: unknown = values;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
const textOfValue = (v: unknown): string => {
  if (v === undefined || v === null) return "";
  const t = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  return t.length > BIND_MAX_CHARS ? `${t.slice(0, BIND_MAX_CHARS - 1)}…` : t;
};

/** UTF-8 bytes of a text node as the parse5 serializer writes it: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, U+00A0 → `&nbsp;`. */
export function escapedTextBytes(text: string): number {
  let extra = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 38) extra += 4;
    else if (c === 60 || c === 62) extra += 3;
    else if (c === 0xa0) extra += 4; // 2 UTF-8 bytes become the 6 of `&nbsp;`
  }
  return Buffer.byteLength(text, "utf8") + extra;
}

/** Does the (sanitized) document bind any data? */
export const bindsData = (html: string): boolean => html.includes(BIND_ATTR);

/** Slot keys of a SANITIZED document in source order, with how often each occurs. The input is parse5 serializer output, where
 *  every attribute is written ` name="value"` (`&` and `"` escaped), so this scan finds every real slot. It may also count a slot
 *  written inside a script, style or comment, which the SDK does not fill: that only makes the budget stricter. */
function slotKeys(html: string): Map<string, number> {
  const keys = new Map<string, number>();
  for (const m of html.matchAll(/\sdata-tb-text="([^"]*)"/g)) {
    const key = (m[1] ?? "").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
    keys.set(key, (keys.get(key) ?? 0) + 1);
  }
  return keys;
}

/** Serve-time data for a page without script: every slot `data-tb-text="<key>[.<path>]"` gets that value as its only child text,
 *  filled by the SDK's `fillTextSlots` (text only, escaped; never into raw-text elements; the SDK's whole-source caps run before
 *  its parse). Unknown paths give empty text. The budget counts what is SERVED: escaped bytes, times the number of slots that show
 *  the key. On any failure the document is returned unbound. */
export function bindData(html: string, values: Record<string, unknown>): string {
  if (!bindsData(html)) return html;
  try {
    const fill: Record<string, string> = {};
    let budget = BIND_MAX_TOTAL_BYTES;
    let cutShown = false;
    for (const [key, count] of slotKeys(html)) {
      let text = textOfValue(lookup(values, key.trim()));
      const cost = escapedTextBytes(text) * count;
      if (cost > budget) {
        // the response has all the inlined data it may carry: cut, with one visible marker (in every slot of that one key, as long
        // as those copies stay within BIND_MARKER_MAX_BYTES), and nothing more after it
        text = !cutShown && escapedTextBytes(BIND_CUT_MARKER) * count <= BIND_MARKER_MAX_BYTES ? BIND_CUT_MARKER : "";
        if (text !== "") cutShown = true;
        budget = 0;
      } else budget -= cost;
      fill[key] = text;
    }
    return fillTextSlots(html, fill, BOUNDED);
  } catch {
    return html;
  }
}
