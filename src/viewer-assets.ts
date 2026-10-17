// Browser code of the viewer (DESIGN §5.2–5.3), kept as text: the shell script/style (our code, top frame, no data in
// HTML) and the `tb` helper injected first into every artifact document (inside the sandbox). Both are tiny and have no
// dependencies. They are served content-hashed under `/v/live-artifacts/_s/` with `immutable` caching.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The `tb` helper an agent page uses: `tb.onData(cb)`, `tb.ready()`. Talks only to its parent (the shell). */
export const TB_HELPER = `(() => {
  "use strict";
  const listeners = [];
  let last = null;
  const parentWin = window.parent;
  window.addEventListener("message", (e) => {
    if (e.source !== parentWin || !e.data || e.data.type !== "tb:data") return;
    last = e.data.data;
    for (const cb of listeners) { try { cb(last); } catch (err) { console.error(err); } }
  });
  const post = (msg) => { try { parentWin.postMessage(msg, "*"); } catch { /* no parent */ } };
  let sentHeight = 0;
  const resize = () => {
    const h = Math.ceil(document.documentElement.scrollHeight);
    if (h !== sentHeight) { sentHeight = h; post({ type: "tb:resize", height: h }); }
  };
  window.tb = Object.freeze({
    onData(cb) { if (typeof cb === "function") { listeners.push(cb); if (last !== null) cb(last); } },
    ready() { post({ type: "tb:ready" }); resize(); },
  });
  window.addEventListener("load", resize);
  if (typeof ResizeObserver === "function") new ResizeObserver(resize).observe(document.documentElement);
})();`;

/** Shell script: loads the data JSON, renders the banner with textContent only, frames the live version, forwards data. */
export const SHELL_JS = `(() => {
  "use strict";
  document.documentElement.dataset.theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  const base = location.pathname.replace(/\\/+$/, "");
  const $ = (id) => document.getElementById(id);
  const MAX_MSG = 256;
  let frame = null, live = 0, etag = null, state = null, ready = false;
  const ago = (iso) => {
    if (!iso) return "never";
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (s < 90) return "just now";
    const m = Math.round(s / 60); if (m < 90) return m + " min ago";
    const h = Math.round(m / 60); if (h < 36) return h + " h ago";
    return Math.round(h / 24) + " days ago";
  };
  const every = (s) => !s ? "" : s % 3600 === 0 ? " · refreshes every " + (s / 3600) + " h" : " · refreshes every " + Math.round(s / 60) + " min";
  const values = () => { const out = {}; for (const [k, v] of Object.entries(state.sources)) if ("data" in v) out[k] = v.data; return out; };
  const send = () => { if (frame && ready && state) frame.contentWindow.postMessage({ type: "tb:data", data: values() }, "*"); };
  function render() {
    $("title").textContent = state.title;
    $("by").textContent = "Shared by " + state.workspace + " · written by an AI agent (" + state.madeBy + ") · never enter passwords here";
    $("fresh").textContent = "Updated " + ago(state.fetchedAt) + every(state.refresh.everySeconds);
    const note = state.stale ? "This page could not refresh. It shows the last data it got." : state.refresh.state === "paused" ? "Refresh is paused." : "";
    $("note").textContent = note; $("note").hidden = note === "";
    if (!frame || state.live !== live) {
      live = state.live; ready = false;
      const f = document.createElement("iframe");
      f.setAttribute("sandbox", "allow-scripts");
      f.setAttribute("referrerpolicy", "no-referrer");
      f.setAttribute("title", state.title);
      f.src = base + "/d/" + live;
      if (frame) frame.replaceWith(f); else $("stage").appendChild(f);
      frame = f;
    }
    send();
  }
  window.addEventListener("message", (e) => {
    if (!frame || e.source !== frame.contentWindow || !e.data || typeof e.data.type !== "string") return;
    if (JSON.stringify(e.data).length > MAX_MSG) return;
    if (e.data.type === "tb:ready") { ready = true; send(); }
    else if (e.data.type === "tb:resize" && Number.isFinite(e.data.height)) frame.style.height = Math.min(Math.max(120, e.data.height), 20000) + "px";
  });
  async function load() {
    try {
      const r = await fetch(base + "/data", { headers: etag ? { "if-none-match": etag } : {}, credentials: "omit", cache: "no-store" });
      if (r.status === 304) return;
      if (!r.ok) { $("note").textContent = r.status === 404 ? "This link is not valid any more." : "This page is not available right now."; $("note").hidden = false; return; }
      etag = r.headers.get("etag"); state = await r.json(); render();
    } catch { /* offline: keep what we have */ }
  }
  load();
  setInterval(() => { if (document.visibilityState === "visible") load(); }, 45000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") load(); });
})();`;

/** Shell layout on the kit tokens (tokens.css is served next to it, @font-face removed: no font loads). */
export const SHELL_CSS = `*{box-sizing:border-box}html,body{margin:0;background:var(--tb-paper);color:var(--tb-ink);font:15px/1.5 var(--tb-font)}
header{padding:12px 16px;border-bottom:1px solid var(--tb-line)}h1{margin:0;font-size:18px;line-height:24px}
p{margin:2px 0 0;color:var(--tb-muted);font-size:13px;line-height:20px}
#note{margin:8px 16px 0;padding:8px 12px;border-radius:var(--tb-radius-brick);background:var(--tb-brick-wash);color:var(--tb-brick-ink)}
#stage{padding:16px}iframe{display:block;width:100%;height:480px;border:1px solid var(--tb-line-strong);border-radius:var(--tb-radius-brick);background:var(--tb-tile)}
footer{padding:0 16px 16px;color:var(--tb-muted);font-size:12px;line-height:16px}`;

/** The kit's tokens.css without @font-face blocks (the viewer loads no fonts). Built UI first, else the installed kit. */
function loadTokens(): string {
  const roots = [new URL("../dist/ui/", import.meta.url), new URL("./ui/", import.meta.url)];
  for (const root of roots) {
    try {
      const dir = fileURLToPath(root);
      const assets = readdirSync(dir).find((d) => d.startsWith("assets-"));
      if (!assets) continue;
      return stripFonts(readFileSync(join(dir, assets, "vendor/@opt2-tealbrick/ui/dist/tokens.css"), "utf8"));
    } catch {
      /* not built here */
    }
  }
  try {
    return stripFonts(readFileSync(fileURLToPath(new URL("../node_modules/@opt2-tealbrick/ui/dist/tokens.css", import.meta.url)), "utf8"));
  } catch {
    return "";
  }
}
export const stripFonts = (css: string): string => css.replace(/@font-face\s*\{[^}]*\}/g, "");
export const TOKENS_CSS = loadTokens();

export const sha16 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
export const SHELL_JS_PATH = `_s/${sha16(SHELL_JS)}.js`;
export const SHELL_CSS_PATH = `_s/${sha16(SHELL_CSS)}.css`;
export const TOKENS_CSS_PATH = `_s/tokens-${sha16(TOKENS_CSS)}.css`;

/** The shell document: static (no artifact data in HTML; the script fills the banner with textContent). */
export const SHELL_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">
<title>Live page</title><link rel="stylesheet" href="/v/live-artifacts/${TOKENS_CSS_PATH}"><link rel="stylesheet" href="/v/live-artifacts/${SHELL_CSS_PATH}"></head>
<body><header><h1 id="title">Loading…</h1><p id="by"></p><p id="fresh"></p></header><p id="note" role="status" hidden></p>
<main id="stage"></main><footer>Tealbrick Live Artifacts. The page above runs in a sandbox with no network.</footer>
<script src="/v/live-artifacts/${SHELL_JS_PATH}"></script></body></html>`;

/** Insert the tb helper as the first script of the agent's document (after <head>, else <html>, else the doctype). */
export function injectHelper(html: string): string {
  const tag = `<script>${TB_HELPER}</script>`;
  for (const re of [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(html);
    if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
  }
  return tag + html;
}
