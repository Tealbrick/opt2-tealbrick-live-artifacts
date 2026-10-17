// Viewer path (DESIGN §5.2–5.3): what a viewer link or an owner preview serves. Pure request → response over the app DB,
// so the same code runs behind the bridge's views origin (LA-1) and in tests. The app does the token work (digest lookup,
// expiry, kind, version, data); the bridge adds the header floor, the host check, rate limits and the pause answer.
//
// URLs (GET only; prefix /v/live-artifacts):
//   /<token>            the shell (our HTML + JS, no data in HTML)
//   /<token>/d/<n>      the artifact document, version n (only the version the link resolves to)
//   /<token>/data       JSON for the shell: banner fields + the sources this link may show (ETag, 304)
//   /_s/<hash>.js|css   shell assets, content-hashed, immutable
import { randomBytes } from "node:crypto";
import { digest, opaqueDigest, ulid } from "@opt2-tealbrick/manifest";
import type { Db, Json } from "@opt2-tealbrick/miniapp-sdk";
import { LIMITS } from "./limits.ts";
import { type Actor, artifactRow, versionRow } from "./store.ts";
import { injectHelper, SHELL_CSS, SHELL_CSS_PATH, SHELL_HTML, SHELL_JS, SHELL_JS_PATH, TOKENS_CSS, TOKENS_CSS_PATH } from "./viewer-assets.ts";

export const VIEW_PREFIX = "/v/live-artifacts";
export const TOKEN_RE = /^tbv_[A-Za-z0-9_-]{43}$/;
export const PREVIEW_TTL_MS = 10 * 60 * 1000;
const DAY_MS = 86_400_000;

/** A new viewer/preview token: `tbv_` + base64url of 32 random bytes. Only its sha256 is stored (LA-5). */
export function newToken(): string {
  return `tbv_${randomBytes(32).toString("base64url")}`;
}

export interface ViewerConfig {
  /** https origin of the views origin (LA-1 `bridge.viewUrl`), or null when the bridge has none */
  viewOrigin: string | null;
  /** https origin of the main bridge origin (the owner UI frames previews from there) */
  mainOrigin: string | null;
  /** shown in the banner ("Shared by <workspace>") */
  workspaceName: string;
}

// ─────────────────────────────────────────────────────────── headers

/** CSP of the shell (DESIGN §5.3). Previews may be framed by the owner UI on the main origin; viewer links by nobody. */
export function shellCsp(cfg: ViewerConfig, preview: boolean): string {
  const frameSrc = cfg.viewOrigin ? `${cfg.viewOrigin}${VIEW_PREFIX}/` : "'self'";
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
/** CSP of the agent document: an opaque origin even when opened directly, no network, framed only by the views origin. */
export function documentCsp(cfg: ViewerConfig): string {
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
    `frame-ancestors ${cfg.viewOrigin ?? "'self'"}`,
  ].join("; ");
}
/** The app's own floor (the bridge forces VIEWER_HEADER_FLOOR as well, LA-1; both are tested). */
export const APP_FLOOR: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "x-dns-prefetch-control": "off",
  "permissions-policy":
    "accelerometer=(), autoplay=(), camera=(), clipboard-read=(), clipboard-write=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), usb=(), xr-spatial-tracking=()",
};

function respond(status: number, body: string | null, type: string, csp: string, extra: Record<string, string> = {}): Response {
  const headers = new Headers({ ...APP_FLOOR, "cache-control": "no-store", "content-security-policy": csp, ...extra });
  if (body !== null) headers.set("content-type", type);
  return new Response(body, { status, headers });
}
/** One answer for every unknown, expired, revoked, archived or mismatched token (DESIGN T5: same body, same code path). */
const NOT_FOUND_BODY = "Not found";
const notFound = () => respond(404, NOT_FOUND_BODY, "text/plain; charset=utf-8", "default-src 'none'; sandbox");

// ─────────────────────────────────────────────────────────── links

export interface LinkRow {
  id: string;
  artifactId: string;
  kind: "viewer" | "preview";
  pinVersion: number | null;
}
/** Resolve a token to a usable link, or null (unknown, expired, revoked, artifact gone or archived). */
export function resolveToken(db: Db, token: string, now: number): LinkRow | null {
  if (!TOKEN_RE.test(token)) return null;
  const r = db.prepare("SELECT * FROM la_link WHERE token_digest = ?").get(opaqueDigest(token));
  if (!r || r.revoked_at !== null || Number(r.expires_at) <= now) return null;
  const a = artifactRow(db, String(r.artifact_id));
  if (!a || String(a.status) !== "active") return null;
  return { id: String(r.id), artifactId: String(r.artifact_id), kind: String(r.kind) as LinkRow["kind"], pinVersion: r.pin_version === null ? null : Number(r.pin_version) };
}

/** Owner preview: a 10-minute token for one version (default: the staged one if any, else the live one). */
export function createPreview(db: Db, artifactId: string, version: number | null, by: Actor, now: number): { token: string; version: number; expiresAt: number } {
  const a = artifactRow(db, artifactId);
  if (!a) throw Object.assign(new Error("no such live page"), { code: "not_found" });
  const n = version ?? (a.staged_version !== null ? Number(a.staged_version) : Number(a.live_version));
  const token = newToken();
  const expiresAt = now + PREVIEW_TTL_MS;
  db.transaction(() => {
    // previews are deleted one day after they expire (DESIGN §4.1)
    db.prepare("DELETE FROM la_link WHERE kind = 'preview' AND expires_at < ?").run(now - DAY_MS);
    db.prepare(
      `INSERT INTO la_link (id, artifact_id, kind, token_digest, label, created_by_type, created_by_id, created_by_name, created_at, expires_at, pin_version)
       VALUES (?, ?, 'preview', ?, 'preview', ?, ?, ?, ?, ?, ?)`,
    ).run(`lnk_${ulid(now)}`, artifactId, opaqueDigest(token), by.type, by.id, by.name, now, expiresAt, n);
  });
  return { token, version: n, expiresAt };
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
    const entry: Record<string, Json> = { status: approved ? String(r.status ?? "empty") : "not_approved", fetchedAt: fetchedAt === null ? null : new Date(fetchedAt).toISOString() };
    if (visible && r.data_json !== null && r.data_json !== undefined) entry.data = JSON.parse(String(r.data_json)) as Json;
    sources[String(r.key)] = entry;
  }
  const every = a.refresh_every_s === null ? null : Number(a.refresh_every_s);
  const stale = every !== null && Number(a.refresh_approved) === 1 && (newest === null || now - newest > 2 * every * 1000);
  const body = {
    title: String(a.title),
    workspace: cfg.workspaceName,
    madeBy: String(a.created_by_name),
    live: versionFor(db, link),
    preview: link.kind === "preview",
    fetchedAt: newest === null ? null : new Date(newest).toISOString(),
    stale: stale || String(a.refresh_state) === "paused_error",
    refresh: { state: String(a.refresh_state), everySeconds: every },
    sources,
  };
  return { ...body, rev: digest(body as Json) };
}

function countView(db: Db, link: LinkRow, now: number): void {
  if (link.kind !== "viewer") return;
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

/** Serve one viewer request. `path` is the URL path (must start with VIEW_PREFIX). */
export function handleViewer(db: Db, req: Request, cfg: ViewerConfig, now: number): Response {
  if (req.method !== "GET") return respond(405, null, "", "default-src 'none'; sandbox", { allow: "GET" });
  const path = new URL(req.url).pathname;
  if (!path.startsWith(`${VIEW_PREFIX}/`)) return notFound();
  const rest = path.slice(VIEW_PREFIX.length + 1).split("/");
  if (rest[0] === "_s") {
    const asset = ASSETS[rest.join("/")];
    if (!asset) return notFound();
    return respond(200, asset.body, asset.type, "default-src 'none'", { "cache-control": "public, max-age=31536000, immutable" });
  }
  const link = resolveToken(db, rest[0] ?? "", now);
  if (!link) return notFound();
  const preview = link.kind === "preview";

  if (rest.length === 1) {
    countView(db, link, now);
    return respond(200, SHELL_HTML, "text/html; charset=utf-8", shellCsp(cfg, preview));
  }
  if (rest.length === 2 && rest[1] === "data") {
    const data = viewData(db, link, cfg, now) as Record<string, Json>;
    const etag = `"${String(data.rev).replace(/^sha256:/, "").slice(0, 32)}"`;
    if (req.headers.get("if-none-match") === etag) return respond(304, null, "", "default-src 'none'", { etag });
    return respond(200, JSON.stringify(data), "application/json; charset=utf-8", "default-src 'none'", { etag });
  }
  if (rest.length === 3 && rest[1] === "d" && /^\d{1,7}$/.test(rest[2] ?? "")) {
    // The document is served only INTO a frame (Fetch Metadata). Opened on its own, a hostile page could still navigate the
    // top window (CSP cannot stop a top-level `location =`); refusing direct opens closes that path. Fail closed: a
    // browser that sends no Sec-Fetch-Dest gets the 404 too.
    if (req.headers.get("sec-fetch-dest") !== "iframe") return notFound();
    const n = Number(rest[2]);
    if (n !== versionFor(db, link)) return notFound(); // a link reads its own version only
    const v = versionRow(db, link.artifactId, n);
    if (!v) return notFound();
    const html = injectHelper(Buffer.from(v.html as Uint8Array).toString("utf8"));
    return respond(200, html, "text/html; charset=utf-8", documentCsp(cfg));
  }
  return notFound();
}

/** Default lifetime bounds for viewer links (S4 creates them; constants live with the viewer rules). */
export const LINK_DAYS = { default: LIMITS.defaultLinkDays, max: LIMITS.maxLinkDays } as const;
