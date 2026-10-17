// Write-time lint of agent HTML (DESIGN §5.3). This is ADVICE so an agent learns at once that the page cannot load outside
// files; it is NOT the security boundary (that is the sandboxed views origin + CSP, S2). Errors refuse the write
// (`view_lint_failed`), advice is returned with the result.

export interface LintItem {
  level: "error" | "advice";
  code: string;
  message: string;
}

const FRAME_TAGS = /<\s*(iframe|object|embed|frame|frameset|portal|applet)\b/i;
const BASE_TAG = /<\s*base\b/i;
// Every repetition is bounded: an agent controls the input, and an unbounded `[^>]*` after a tag start is quadratic on
// a page full of "<meta " without ">" (review of PR #1: 6.8 s per regex on 256 KiB). A meta tag longer than 300 chars (others: 2000) is
// not inspected (advice only; the sandbox is the boundary).
const META_REFRESH = /<\s*meta\b[^>]{0,300}?http-equiv\s*=\s*["']?\s*refresh/i;
/** src= / srcset= / poster= / data= / href= on a <link> pointing outside the document */
const ATTR_URL = /\b(src|srcset|poster|data|background|href|formaction|xlink:href)\s*=\s*(?:"([^"]{0,4096})"|'([^']{0,4096})'|([^\s>]{1,4096}))/gi;
const CSS_URL = /url\(\s*["']?\s*([^"')\s]{1,4096})/gi;
/** href on these tags loads or navigates; <a href> navigation cannot leave the sandbox but is still a sign of an outside link */
const HREF_ATTRS = new Set(["href", "xlink:href"]);
const CSS_IMPORT = /@import\b/i;
const NETWORK_API = /\b(fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|RTCPeerConnection)/;
const FORM_TAG = /<\s*form\b/i;

/** true when a URL value would load something outside the document (any scheme or host except data:/blob:/fragment). */
export function isExternal(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === "" || v.startsWith("#") || v.startsWith("data:") || v.startsWith("blob:")) return false;
  if (v.startsWith("//")) return true;
  if (/^[a-z][a-z0-9+.-]*:/.test(v)) return true; // http:, https:, javascript:, ftp: …
  return false;
}
const isRelative = (value: string): boolean => !isExternal(value) && !/^(#|data:|blob:)/i.test(value.trim());

export function lintHtml(html: string): LintItem[] {
  const out: LintItem[] = [];
  const err = (code: string, message: string) => out.push({ level: "error", code, message });
  const advice = (code: string, message: string) => out.push({ level: "advice", code, message });

  if (FRAME_TAGS.test(html)) err("embedded_frame", "Frames, objects and embeds are not allowed. Put everything in this one page.");
  if (BASE_TAG.test(html)) err("base_tag", "A <base> tag is not allowed.");
  if (META_REFRESH.test(html)) err("meta_refresh", "<meta http-equiv=refresh> is not allowed. The page refreshes its data by itself.");
  if (CSS_IMPORT.test(html)) err("css_import", "@import is not allowed. Put all styles in this page.");

  const urls: string[] = [];
  const links: string[] = [];
  for (const m of html.matchAll(ATTR_URL)) {
    const attr = (m[1] ?? "").toLowerCase();
    const raw = (m[2] ?? m[3] ?? m[4] ?? "").trim();
    if (HREF_ATTRS.has(attr)) {
      // <link href> loads (stylesheet, prefetch …); <a href>/<use href> navigate or reference
      const at = m.index ?? 0;
      const back = html.slice(Math.max(0, at - 2000), at); // bounded look-back (no quadratic scan)
      const lt = back.lastIndexOf("<");
      const tag = lt < 0 ? undefined : /^<\s*([a-z]+)/i.exec(back.slice(lt, lt + 20))?.[1]?.toLowerCase();
      if (tag === "link" || tag === "use" || tag === "image") urls.push(raw);
      else links.push(raw);
      continue;
    }
    // srcset holds a list "url 1x, url 2x"
    const parts = attr === "srcset" ? raw.split(",").map((p) => p.trim().split(/\s+/)[0] ?? "") : [raw];
    urls.push(...parts);
  }
  for (const m of html.matchAll(CSS_URL)) urls.push(m[1] ?? "");
  const external = urls.filter(isExternal);
  if (external.length > 0)
    err(
      "external_resource",
      `The page loads ${external.length} outside file(s) (first: ${external[0]?.slice(0, 80)}). Outside files are removed when the page is shown: inline scripts, styles and images (data: URLs).`,
    );
  const relative = urls.filter((u) => u && isRelative(u));
  if (relative.length > 0) advice("relative_resource", `The page names ${relative.length} other file(s) (first: ${relative[0]?.slice(0, 80)}). A page is one file; these do not load.`);

  const outsideLinks = links.filter(isExternal);
  if (outsideLinks.length > 0) advice("outside_link", `The page links to ${outsideLinks.length} outside address(es). Links cannot open from a live page.`);
  if (NETWORK_API.test(html)) advice("network_api", "The page uses a network API (fetch, XMLHttpRequest, WebSocket …). Do not send data to outside sites; use tb.onData(cb) to get your data.");
  if (FORM_TAG.test(html)) advice("form", "Forms cannot submit on a live page.");
  return out;
}

export const lintErrors = (items: readonly LintItem[]): LintItem[] => items.filter((i) => i.level === "error");
