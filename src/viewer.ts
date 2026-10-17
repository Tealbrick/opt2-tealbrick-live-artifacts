// Viewer path (DESIGN §5.2–5.3): what a viewer link or an owner preview serves. Pure request → response over the app DB,
// so the same code runs behind the bridge's views origin (LA-1) and in tests. The app does the token work (digest lookup,
// expiry, kind, version, data); the bridge adds the header floor, the host check, rate limits and the pause answer.
//
// URLs (GET only). The public address is https://<views origin>/v/live-artifacts/…; the SDK serves the manifest viewer route
// (`publicRoutes` `/v`, purpose `viewer`, MANIFEST M-PR-2) and hands the handler the path WITHOUT that prefix, so the
// paths below are what the handler sees:
//   /<token>            the shell (our HTML + JS, no data in HTML)
//   /<token>/data       JSON for the shell: banner fields, the sources this link may show (ETag, 304), and `doc`
//   /_d/<doc ticket>    the artifact document. The ticket is NOT the link token (review PR #2, finding 3: agent code can
//                       read its own URL): an HMAC over (link, version, expiry) that authorises only this HTML, which
//                       the page holds anyway. It is served only into a frame (Sec-Fetch-Dest: iframe).
//   /_s/<hash>.js|css   shell assets, content-hashed, immutable
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { digest, opaqueDigest, ulid, VIEWER_HEADER_FLOOR } from "@opt2-tealbrick/manifest";
import type { AppSecrets, Db, Json } from "@opt2-tealbrick/miniapp-sdk";
import { bindData, bindsData, versionPlain, versionServed } from "./sanitize.ts";
import { type Actor, artifactRow, versionRow } from "./store.ts";
import { injectHelper, SHELL_CSS, SHELL_CSS_PATH, SHELL_HTML, SHELL_JS, SHELL_JS_PATH, TOKENS_CSS, TOKENS_CSS_PATH } from "./viewer-assets.ts";

/** The public path prefix on the views origin (the SDK strips it before our handler runs). Used to build addresses and CSPs. */
export const VIEW_PREFIX = "/v/live-artifacts";
export const TOKEN_RE = /^tbv_[A-Za-z0-9_-]{43}$/;
export const PREVIEW_TTL_MS = 10 * 60 * 1000;
/** live preview tokens per page */
export const PREVIEWS_PER_ARTIFACT = 3;
/** document tickets last 10–15 minutes (5-minute buckets keep the /data ETag stable); the shell refreshes them */
const DOC_BUCKET_MS = 5 * 60 * 1000;

/** A new viewer/preview token: `tbv_` + base64url of 32 random bytes. Only its sha256 is stored (LA-5). */
export function newToken(): string {
  return `tbv_${randomBytes(32).toString("base64url")}`;
}

export interface ViewerConfig {
  /** HMAC key for document tickets (an app secret, ctx.secrets; never leaves the app) */
  docKey: string;
  /** https origin of the views origin (LA-1 `bridge.viewUrl`), or null when the bridge has none */
  viewOrigin: string | null;
  /** https origin of the main bridge origin (the owner UI frames previews from there) */
  mainOrigin: string | null;
  /** shown in the banner ("Shared by <workspace>") */
  workspaceName: string;
}

// ─────────────────────────────────────────────────────────── document ticket key

/** The app secret that signs document tickets. Created once, kept in the SDK's sealed secret store (ctx.secrets), never
 *  logged, never in a response. */
export const DOC_KEY_SECRET = "doc_ticket_key";
let docKeyCache: string | null = null;
let docKeyPending: Promise<string> | null = null;
/** Tests inject a key (null clears it). */
export function setDocKey(key: string | null): void {
  docKeyCache = key;
}
/** The signing key: read from the secret store, created on first use (onStart calls this once at boot). Absent or
 *  unreadable (restored into another deployment) → a new key; the tickets the old key signed stop working. */
export function ensureDocKey(secrets: Pick<AppSecrets, "get" | "put">): Promise<string> {
  if (docKeyCache !== null) return Promise.resolve(docKeyCache);
  docKeyPending ??= (async () => {
    let key = await secrets.get(DOC_KEY_SECRET);
    if (!key) {
      key = randomBytes(32).toString("base64url");
      await secrets.put(DOC_KEY_SECRET, key);
    }
    docKeyCache = key;
    return key;
  })().finally(() => {
    docKeyPending = null;
  });
  return docKeyPending;
}

/** `https://host[:port]` only (no path, query, user info or spaces): the value goes into CSP headers and addresses
 *  (review PR #2, finding 11). The SDK's requireViewUrl checks only that the string is not empty, so this check stays. */
export function httpsOrigin(v: unknown): string | null {
  return typeof v === "string" && /^https:\/\/[a-z0-9.-]{1,253}(:\d{1,5})?$/.test(v) ? v : null;
}

// ─────────────────────────────────────────────────────────── headers

/** CSP of the shell (DESIGN §5.3). Previews may be framed by the owner UI on the main origin; viewer links by nobody.
 *  The shell may frame only document tickets (review PR #2, finding 5). */
export function shellCsp(cfg: ViewerConfig, preview: boolean): string {
  const frameSrc = cfg.viewOrigin ? `${cfg.viewOrigin}${VIEW_PREFIX}/_d/` : "'none'"; // no views origin: nothing is served (handleViewer answers 503)
  const ancestors = preview && cfg.mainOrigin ? cfg.mainOrigin : "'none'";
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    `frame-src ${frameSrc}`,
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    `frame-ancestors ${ancestors}`,
  ].join("; ");
}
/** CSP of the agent document: an opaque origin even when opened directly, no cookies or storage, connect-src none, framed only by the shell (views
 *  origin; for a preview also the owner UI above the shell — frame-ancestors checks EVERY ancestor, finding 2). */
export function documentCsp(cfg: ViewerConfig, preview = false): string {
  const ancestors = [cfg.viewOrigin ?? "'none'", ...(preview && cfg.mainOrigin ? [cfg.mainOrigin] : [])].join(" ");
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${ancestors}`,
  ].join("; ");
}
/** CSP of the scriptless render (C239): a page that runs no script, or a link the owner did not approve for scripts. No script
 *  can run: `script-src 'none'`, and the CSP sandbox has no `allow-scripts` either. Nothing is fetched (data was inlined when it
 *  was served), so `img-src` is data: only. Still a sandbox (opaque origin), still framed only by the shell. */
export function scriptlessDocumentCsp(cfg: ViewerConfig, preview = false): string {
  const ancestors = [cfg.viewOrigin ?? "'none'", ...(preview && cfg.mainOrigin ? [cfg.mainOrigin] : [])].join(" ");
  return [
    "sandbox",
    "default-src 'none'",
    "script-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "media-src data:",
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${ancestors}`,
  ].join("; ");
}

/** Which document a link gets for this page code: the page as it is (scripts allowed) only when the page runs scripts AND the
 *  owner approved this link for that; otherwise the scriptless render (scripts removed). Decided from the sanitized document. */
export function renderFor(version: Record<string, unknown>, link: LinkRow): { html: string; scriptless: boolean; runsScripts: boolean } {
  const full = versionServed(version);
  if (full.runsScripts && link.scriptsOk) return { html: full.html, scriptless: false, runsScripts: true };
  return { html: versionPlain(version), scriptless: true, runsScripts: full.runsScripts };
}
const valuesOf = (sources: Record<string, Json>): Record<string, Json> => {
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(sources)) if (v !== null && typeof v === "object" && !Array.isArray(v) && "data" in v) out[k] = (v as Record<string, Json>).data as Json;
  return out;
};

/** Every answer carries the shared floor (VIEWER_HEADER_FLOOR, manifest 0.1.21, L1; the SDK forces it again) and replaces
 *  only the CSP with one of ours; `extra` may mark content-hashed assets cacheable. */
function respond(status: number, body: string | null, type: string, csp: string, extra: Record<string, string> = {}): Response {
  const headers = new Headers({ ...VIEWER_HEADER_FLOOR, "content-security-policy": csp, ...extra });
  if (body !== null) headers.set("content-type", type);
  return new Response(body, { status, headers });
}
/** One answer for every unknown, expired, revoked, archived or mismatched token (DESIGN T5: same body, same code path). */
const NOT_FOUND_BODY = "Not found";
const BARE_CSP = "default-src 'none'; sandbox; frame-ancestors 'none'";
const notFound = () => respond(404, NOT_FOUND_BODY, "text/plain; charset=utf-8", BARE_CSP);

// ─────────────────────────────────────────────────────────── links

export interface LinkRow {
  id: string;
  artifactId: string;
  kind: "viewer" | "preview";
  pinVersion: number | null;
  /** the owner approved this link for a page that runs scripts; false = always the scriptless render */
  scriptsOk: boolean;
}
// ─────────────────────────────────────────────────────────── restore (S6 review S3-3)

/** A restore replaces the database with an older one: a link revoked after that backup is active again in it, and the app cannot
 *  know which. So every link is ended after a restore and the owner makes new ones.
 *  The SDK keeps its own restore marker in `tb_*` tables the app may not read, so the app writes its own: the SDK's
 *  `afterRestore` hook (which runs before the store opens, and whose failure rolls the restore back) records
 *  `la_setting.restore_pending` straight into the restored file; `endLinksAfterRestore` writes `restore_handled` = the same value
 *  in the SAME transaction that ends the links. A pending value without a matching handled value means the restore is not handled
 *  yet, also after a crash between the two: no link opens, and onStart ends them. Nothing is kept in memory. */
export function restoreUnhandled(db: Db): boolean {
  const p = db.prepare("SELECT value FROM la_setting WHERE key = 'restore_pending'").get();
  if (!p) return false;
  const h = db.prepare("SELECT value FROM la_setting WHERE key = 'restore_handled'").get();
  return !h || String(h.value) !== String(p.value);
}

/** The `afterRestore` hook: record the restore in the restored database file (before the store opens). Throws on any failure,
 *  and the SDK then rolls the whole restore back (fail closed). */
export function recordRestore(dataDir: string | undefined): void {
  if (!dataDir) throw new Error("TB_DATA_DIR is not set; the restore cannot be recorded");
  const raw = new DatabaseSync(join(dataDir, "app.db"));
  try {
    raw.prepare("INSERT INTO la_setting (key, value) VALUES ('restore_pending', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(`${Date.now()}-${randomBytes(8).toString("hex")}`);
  } finally {
    raw.close();
  }
}

/** End every link and every preview after a restore, once, and record that in the same transaction. Pages, versions, data and
 *  hold flags are kept as restored. */
export function endLinksAfterRestore(db: Db, now: number): number {
  return db.transaction(() => {
    const marker = db.prepare("SELECT value FROM la_setting WHERE key = 'restore_pending'").get()?.value;
    const rows = db.prepare("SELECT artifact_id, COUNT(*) AS c FROM la_link WHERE kind = 'viewer' AND revoked_at IS NULL AND expires_at > ? GROUP BY artifact_id").all(now);
    db.prepare("UPDATE la_link SET revoked_at = ? WHERE kind = 'viewer' AND revoked_at IS NULL AND expires_at > ?").run(now, now);
    db.prepare("DELETE FROM la_link WHERE kind = 'preview'").run();
    for (const r of rows) {
      db.prepare("INSERT INTO la_activity (id, artifact_id, at, action, by_type, by_id, by_name, summary) VALUES (?, ?, ?, 'link.revoke', 'app', 'restore', 'Restore', ?)").run(
        `act_${ulid(now)}`,
        String(r.artifact_id),
        now,
        `${Number(r.c)} link(s) ended because the data was restored from a backup; create new links`,
      );
    }
    if (marker !== undefined) db.prepare("INSERT INTO la_setting (key, value) VALUES ('restore_handled', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(marker));
    return rows.reduce((n, r) => n + Number(r.c), 0);
  });
}

/** Resolve a token to a usable link, or null (unknown, expired, revoked, artifact gone or archived). */
export function resolveToken(db: Db, token: string, now: number): LinkRow | null {
  if (!TOKEN_RE.test(token)) return null;
  return usableLink(db.prepare("SELECT * FROM la_link WHERE token_digest = ?").get(opaqueDigest(token)), db, now);
}
function usableLink(r: Record<string, unknown> | undefined, db: Db, now: number): LinkRow | null {
  if (restoreUnhandled(db)) return null; // a restore happened and the links are not ended yet (the app is about to do that)
  if (!r || r.revoked_at !== null || Number(r.expires_at) <= now) return null;
  const a = artifactRow(db, String(r.artifact_id));
  if (!a || String(a.status) !== "active") return null;
  return { id: String(r.id), artifactId: String(r.artifact_id), kind: String(r.kind) as LinkRow["kind"], pinVersion: r.pin_version === null ? null : Number(r.pin_version), scriptsOk: Number(r.scripts_ok ?? 0) === 1 };
}

/** Owner preview: a 10-minute token for one version (default: the staged one if any, else the live one). */
export function createPreview(db: Db, artifactId: string, version: number | null, by: Actor, now: number): { token: string; version: number; expiresAt: number } {
  const a = artifactRow(db, artifactId);
  if (!a) throw Object.assign(new Error("no such live page"), { code: "not_found" });
  const n = version ?? (a.staged_version !== null ? Number(a.staged_version) : Number(a.live_version));
  const token = newToken();
  const expiresAt = now + PREVIEW_TTL_MS;
  db.transaction(() => {
    // expired previews go at once; at most PREVIEWS_PER_ARTIFACT live ones per page (the oldest is dropped; finding 13)
    db.prepare("DELETE FROM la_link WHERE kind = 'preview' AND expires_at <= ?").run(now);
    db.prepare(
      `DELETE FROM la_link WHERE kind = 'preview' AND artifact_id = ?1 AND id NOT IN
         (SELECT id FROM la_link WHERE kind = 'preview' AND artifact_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2)`,
    ).run(artifactId, PREVIEWS_PER_ARTIFACT - 1);
    db.prepare(
      `INSERT INTO la_link (id, artifact_id, kind, token_digest, label, created_by_type, created_by_id, created_by_name, created_at, expires_at, pin_version, scripts_ok)
       VALUES (?, ?, 'preview', ?, 'preview', ?, ?, ?, ?, ?, ?, 1)`,
    ).run(`lnk_${ulid(now)}`, artifactId, opaqueDigest(token), by.type, by.id, by.name, now, expiresAt, n);
  });
  return { token, version: n, expiresAt };
}

const mac = (key: string, payload: string): string => createHmac("sha256", key).update(payload).digest("base64url").slice(0, 32);
/** A document ticket for (link, version): `<linkId>.<n>.<exp>.<mac>`. It authorises only that version's HTML. */
export function docTicket(cfg: ViewerConfig, linkId: string, n: number, now: number): string {
  const exp = (Math.floor(now / DOC_BUCKET_MS) + 3) * DOC_BUCKET_MS;
  return `${linkId}.${n}.${exp}.${mac(cfg.docKey, `${linkId}|${n}|${exp}`)}`;
}
function checkTicket(cfg: ViewerConfig, ticket: string, now: number): { linkId: string; n: number } | null {
  const m = /^(lnk_[0-9A-HJKMNP-TV-Z]{26})\.(\d{1,7})\.(\d{13})\.([A-Za-z0-9_-]{32})$/.exec(ticket);
  if (!m) return null;
  const [, linkId, n, exp, got] = m as unknown as [string, string, string, string, string];
  if (Number(exp) <= now) return null;
  const want = Buffer.from(mac(cfg.docKey, `${linkId}|${n}|${exp}`));
  const have = Buffer.from(got);
  if (want.length !== have.length || !timingSafeEqual(want, have)) return null;
  return { linkId, n: Number(n) };
}

/** The version a link shows: a pinned one, else the live one. */
function versionFor(db: Db, link: LinkRow): number {
  if (link.pinVersion !== null) return link.pinVersion;
  return Number(artifactRow(db, link.artifactId)?.live_version ?? 0);
}

/** What the shell gets. Viewer links see only sources the owner marked "show to people with a link"; previews (owner)
 *  see every approved source. Staged data is never shown. Unapproved read sources show no data. */
export function viewData(db: Db, link: LinkRow, cfg: ViewerConfig, now: number): Json {
  const a = artifactRow(db, link.artifactId);
  if (!a) return null;
  const sources: Record<string, Json> = {};
  let newest: number | null = null;
  for (const r of db
    .prepare(
      `SELECT s.key, s.kind, s.viewers, s.approved_digest, s.digest, n.data_json, n.fetched_at, n.status
         FROM la_source s LEFT JOIN la_snapshot n ON n.artifact_id = s.artifact_id AND n.key = s.key WHERE s.artifact_id = ? ORDER BY s.rowid`,
    )
    .all(link.artifactId)) {
    const approved = r.approved_digest !== null && r.approved_digest === r.digest;
    const visible = approved && (link.kind === "preview" || Number(r.viewers) === 1);
    const fetchedAt = r.fetched_at === null || r.fetched_at === undefined ? null : Number(r.fetched_at);
    if (visible && fetchedAt !== null && (newest === null || fetchedAt > newest)) newest = fetchedAt;
    // a viewer link learns nothing about sources it may not show: no entry at all (finding 4); the owner's preview
    // lists every source with its state
    if (!visible && link.kind !== "preview") continue;
    const entry: Record<string, Json> = { status: approved ? String(r.status ?? "empty") : "not_approved", fetchedAt: fetchedAt === null ? null : new Date(fetchedAt).toISOString() };
    if (visible && r.data_json !== null && r.data_json !== undefined) entry.data = JSON.parse(String(r.data_json)) as Json;
    sources[String(r.key)] = entry;
  }
  const every = a.refresh_every_s === null ? null : Number(a.refresh_every_s);
  const stale = every !== null && Number(a.refresh_approved) === 1 && (newest === null || now - newest > 2 * every * 1000);
  const shown = versionRow(db, link.artifactId, versionFor(db, link));
  const render = shown ? renderFor(shown, link) : null;
  const body = {
    title: String(a.title),
    workspace: cfg.workspaceName,
    madeBy: String(a.created_by_name),
    live: versionFor(db, link),
    doc: `_d/${docTicket(cfg, link.id, versionFor(db, link), now)}`,
    preview: link.kind === "preview",
    fetchedAt: newest === null ? null : new Date(newest).toISOString(),
    stale: stale || String(a.refresh_state) === "paused_error",
    refresh: { state: String(a.refresh_state), everySeconds: every },
    sources,
    // the shell frames a scriptless document without allow-scripts and reloads it when its inlined data changes
    scriptless: render?.scriptless ?? true,
    runsScripts: render?.runsScripts ?? false,
    docRev: render?.scriptless && bindsData(render.html) ? digest(valuesOf(sources)) : null,
  };
  return { ...body, rev: digest(body as Json) };
}

/** Counts shell loads of viewer links that are real page navigations (Sec-Fetch-Dest: document), not unfurl bots or
 *  prefetches without Fetch Metadata (finding 9). */
function countView(db: Db, link: LinkRow, req: Request, now: number): void {
  if (link.kind !== "viewer" || req.headers.get("sec-fetch-dest") !== "document") return;
  const day = new Date(now).toISOString().slice(0, 10);
  db.transaction(() => {
    db.prepare("UPDATE la_link SET views = views + 1, last_seen_day = ? WHERE id = ?").run(day, link.id);
    db.prepare("INSERT INTO la_view_day (link_id, day, count) VALUES (?, ?, 1) ON CONFLICT (link_id, day) DO UPDATE SET count = count + 1").run(link.id, day);
  });
}

// ─────────────────────────────────────────────────────────── handler

const ASSETS: Record<string, { body: string; type: string }> = {
  [SHELL_JS_PATH]: { body: SHELL_JS, type: "text/javascript; charset=utf-8" },
  [SHELL_CSS_PATH]: { body: SHELL_CSS, type: "text/css; charset=utf-8" },
  [TOKENS_CSS_PATH]: { body: TOKENS_CSS, type: "text/css; charset=utf-8" },
};

/** Serve one viewer request. The URL path is the one the SDK hands a viewer route: `/<rest>` WITHOUT `/v/live-artifacts`. */
export function handleViewer(db: Db, req: Request, cfg: ViewerConfig, now: number): Response {
  if (req.method !== "GET") return respond(405, null, "", BARE_CSP, { allow: "GET" });
  // Without a views origin nothing may be served: the frame-src and frame-ancestors of the shell and the document name it,
  // and an 'self' fallback would let a page frame itself on whatever address it was reached at.
  if (cfg.viewOrigin === null) return respond(503, "Viewer pages are not available", "text/plain; charset=utf-8", BARE_CSP, { "retry-after": "60" });
  const rest = new URL(req.url).pathname.slice(1).split("/");
  if (rest[0] === "_s") {
    const asset = ASSETS[rest.join("/")];
    if (!asset) return notFound();
    return respond(200, asset.body, asset.type, "default-src 'none'", { "cache-control": "public, max-age=31536000, immutable" });
  }
  if (rest[0] === "_d" && rest.length === 2) {
    // The document is served only INTO a frame (Fetch Metadata). Opened on its own, a hostile page could still navigate
    // the top window (CSP cannot stop a top-level `location =`). Fail closed: no Sec-Fetch-Dest → 404 too.
    if (req.headers.get("sec-fetch-dest") !== "iframe") return notFound();
    const t = checkTicket(cfg, rest[1] ?? "", now);
    if (!t) return notFound();
    const link = usableLink(db.prepare("SELECT * FROM la_link WHERE id = ?").get(t.linkId), db, now);
    if (!link || t.n !== versionFor(db, link)) return notFound(); // a link reads its own version only
    const v = versionRow(db, link.artifactId, t.n);
    if (!v) return notFound();
    // every agent document is sanitized on the way out (C238): owner preview and public link share this one call
    const render = renderFor(v, link);
    const preview = link.kind === "preview";
    if (!render.scriptless) return respond(200, injectHelper(render.html), "text/html; charset=utf-8", documentCsp(cfg, preview));
    // scriptless render (C239): no helper, no script can run, and the data is inlined now so the page needs no fetch
    let doc = render.html;
    if (bindsData(doc)) doc = bindData(doc, valuesOf(((viewData(db, link, cfg, now) as Record<string, Json>).sources ?? {}) as Record<string, Json>));
    return respond(200, doc, "text/html; charset=utf-8", scriptlessDocumentCsp(cfg, preview));
  }
  const link = resolveToken(db, rest[0] ?? "", now);
  if (!link) return notFound();
  const preview = link.kind === "preview";
  if (rest.length === 1) {
    countView(db, link, req, now);
    return respond(200, SHELL_HTML, "text/html; charset=utf-8", shellCsp(cfg, preview));
  }
  if (rest.length === 2 && rest[1] === "data") {
    const data = viewData(db, link, cfg, now) as Record<string, Json>;
    const etag = `"${String(data.rev).replace(/^sha256:/, "").slice(0, 32)}"`;
    if (req.headers.get("if-none-match") === etag) return respond(304, null, "", "default-src 'none'", { etag });
    return respond(200, JSON.stringify(data), "application/json; charset=utf-8", "default-src 'none'", { etag });
  }
  return notFound();
}

