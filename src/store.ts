// Artifact store over the app's own tables (migrations/0001_init.sql). Plain functions over the SDK's Db handle, so the
// handlers stay thin and the tests run them against the migrated database. One state change = one transaction (L31).
import { digest, sha256Bytes, ulid } from "@opt2-tealbrick/manifest";
import { type Db, type Json, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { type Contract, type ContractInput, contractJson, parseStoredContract, sourceDigest } from "./contract.ts";
import { LIMITS, utf8Bytes } from "./limits.ts";
import { SANITIZER_VERSION, sanitizeHtml } from "./sanitize.ts";

/** Manifest `scopes[].type` that guards artifacts. */
export const GALLERY = "gallery";
/** The one shared gallery (created in onStart, `shared: true`). */
export const SHARED_GALLERY = "shared";

export interface Actor {
  type: "agent" | "app" | "person";
  id: string;
  name: string;
}
type Row = Record<string, unknown>;

const iso = (ms: unknown): string | null => (ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString());
const isoNow = (ms: number): string => new Date(ms).toISOString();
const actorOf = (r: Row, p: string): Actor => ({ type: String(r[`${p}_type`]) as Actor["type"], id: String(r[`${p}_id`]), name: String(r[`${p}_name`]) });

export const notFound = (): TbError => new TbError("not_found", "no such live page", 404);

// ─────────────────────────────────────────────────────────── reads

export function artifactRow(db: Db, id: string): Row | undefined {
  return db.prepare("SELECT * FROM la_artifact WHERE id = ?").get(id);
}
export function versionRow(db: Db, id: string, n: number): Row | undefined {
  return db.prepare("SELECT * FROM la_version WHERE artifact_id = ? AND n = ?").get(id, n);
}
export function newestVersion(db: Db, id: string): number {
  const r = db.prepare("SELECT MAX(n) AS n FROM la_version WHERE artifact_id = ?").get(id);
  return Number(r?.n ?? 0);
}
export function activeLinkCount(db: Db, id: string, now: number): number {
  const r = db.prepare("SELECT COUNT(*) AS c FROM la_link WHERE artifact_id = ? AND kind = 'viewer' AND revoked_at IS NULL AND expires_at > ?").get(id, now);
  return Number(r?.c ?? 0);
}
function sourcesPending(db: Db, id: string): number {
  const r = db
    .prepare("SELECT COUNT(*) AS c FROM la_source WHERE artifact_id = ? AND kind = 'read' AND (approved_digest IS NULL OR approved_digest <> digest)")
    .get(id);
  return Number(r?.c ?? 0);
}

export interface Summary {
  id: string;
  title: string;
  description: string;
  gallery: string;
  status: "active" | "archived";
  liveVersion: number;
  stagedVersion: number | null;
  links: number;
  sourcesPending: number;
  refresh: { everySeconds: number | null; lastAt: string | null; nextAt: string | null; state: string };
  updatedAt: string;
  createdBy: Actor;
}
export function toSummary(db: Db, r: Row, now: number): Summary {
  const id = String(r.id);
  return {
    id,
    title: String(r.title),
    description: String(r.description),
    gallery: String(r.gallery_id),
    status: String(r.status) as Summary["status"],
    liveVersion: Number(r.live_version),
    stagedVersion: r.staged_version === null ? null : Number(r.staged_version),
    links: activeLinkCount(db, id, now),
    sourcesPending: sourcesPending(db, id),
    refresh: {
      everySeconds: r.refresh_every_s === null ? null : Number(r.refresh_every_s),
      lastAt: iso(r.last_refresh_at),
      nextAt: iso(r.next_refresh_at),
      state: String(r.refresh_state),
    },
    updatedAt: isoNow(Number(r.updated_at)),
    createdBy: actorOf(r, "created_by"),
  };
}
export function toDetail(db: Db, r: Row, now: number) {
  return {
    ...toSummary(db, r, now),
    autoPublish: String(r.auto_publish) as "owner" | "agent",
    origin: { kind: String(r.origin_kind), ref: r.origin_ref === null ? null : String(r.origin_ref) },
    forkedFrom: r.forked_from === null ? null : String(r.forked_from),
    createdAt: isoNow(Number(r.created_at)),
  };
}

export function versionOut(r: Row) {
  return {
    n: Number(r.n),
    sha256: String(r.html_sha256),
    bytes: Number(r.bytes),
    createdBy: actorOf(r, "created_by"),
    createdAt: isoNow(Number(r.created_at)),
    note: String(r.note),
    html: Buffer.from(r.html as Uint8Array).toString("utf8"),
    contract: JSON.parse(String(r.contract_json)) as Json,
  };
}
export function versionsOf(db: Db, a: Row) {
  return db
    .prepare("SELECT n, html_sha256, bytes, created_by_type, created_by_id, created_by_name, created_at, note FROM la_version WHERE artifact_id = ? ORDER BY n DESC")
    .all(a.id)
    .map((r) => ({
      n: Number(r.n),
      sha256: String(r.html_sha256),
      bytes: Number(r.bytes),
      createdBy: actorOf(r, "created_by"),
      createdAt: isoNow(Number(r.created_at)),
      note: String(r.note),
      live: Number(r.n) === Number(a.live_version),
      staged: a.staged_version !== null && Number(r.n) === Number(a.staged_version),
    }));
}
export function sourcesOf(db: Db, id: string) {
  return db
    .prepare(
      `SELECT s.*, n.status AS snap_status, n.fetched_at AS snap_fetched_at, n.code AS snap_code, n.staged_json AS snap_staged
         FROM la_source s LEFT JOIN la_snapshot n ON n.artifact_id = s.artifact_id AND n.key = s.key
        WHERE s.artifact_id = ? ORDER BY s.rowid`,
    )
    .all(id)
    .map((r) => {
      const approved = r.approved_digest !== null && r.approved_digest === r.digest;
      return {
        key: String(r.key),
        kind: String(r.kind) as "push" | "read",
        label: String(r.label),
        product: r.product === null ? null : String(r.product),
        op: r.op === null ? null : String(r.op),
        input: r.input_json === null ? null : (JSON.parse(String(r.input_json)) as Json),
        projection: r.projection_json === null ? null : (JSON.parse(String(r.projection_json)) as Json),
        digest: String(r.digest),
        approved,
        viewers: Number(r.viewers) === 1,
        status: (r.snap_status === null || r.snap_status === undefined ? (approved ? "empty" : "not_approved") : String(r.snap_status)) as string,
        fetchedAt: iso(r.snap_fetched_at ?? null),
        staged: r.snap_staged !== null && r.snap_staged !== undefined,
        code: r.snap_code === null || r.snap_code === undefined ? null : String(r.snap_code),
      };
    });
}
export function linksOf(db: Db, id: string, now: number) {
  return db
    .prepare("SELECT * FROM la_link WHERE artifact_id = ? AND kind = 'viewer' ORDER BY created_at DESC")
    .all(id)
    .map((r) => ({
      id: String(r.id),
      label: String(r.label),
      createdBy: actorOf(r, "created_by"),
      createdAt: isoNow(Number(r.created_at)),
      expiresAt: isoNow(Number(r.expires_at)),
      revokedAt: iso(r.revoked_at),
      pinVersion: r.pin_version === null ? null : Number(r.pin_version),
      views: Number(r.views),
      lastSeenDay: r.last_seen_day === null ? null : String(r.last_seen_day),
      status: (r.revoked_at !== null ? "revoked" : Number(r.expires_at) <= now ? "expired" : "active") as "active" | "expired" | "revoked",
    }));
}

/** Shape of a JSON value without its values (DESIGN §4.4 rule 3: agents learn keys, types and row counts, never values). */
export function shapeOf(v: unknown, depth = 0): Json {
  if (v === null) return { type: "null" };
  if (Array.isArray(v)) return depth >= 2 ? { type: "array", rows: v.length } : { type: "array", rows: v.length, item: v.length > 0 ? shapeOf(v[0], depth + 1) : null };
  if (typeof v === "object") {
    if (depth >= 2) return { type: "object", keys: Object.keys(v as object).length };
    const keys: Record<string, Json> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 50)) keys[k] = shapeOf(x, depth + 1);
    return { type: "object", keys };
  }
  return { type: typeof v };
}
/** Shapes of every snapshot of an artifact (live data only). */
export function shapesOf(db: Db, id: string): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const r of db
    .prepare("SELECT n.key, n.data_json FROM la_snapshot n JOIN la_source s ON s.artifact_id = n.artifact_id AND s.key = n.key WHERE n.artifact_id = ? AND n.data_json IS NOT NULL")
    .all(id))
    out[String(r.key)] = shapeOf(JSON.parse(String(r.data_json)));
  return out;
}
/** Values of PUSH sources only (the agents' own data; read-source values never go back to agents, C88/L12). */
export function pushedDataOf(db: Db, id: string): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const r of db
    .prepare(
      "SELECT n.key, n.data_json FROM la_snapshot n JOIN la_source s ON s.artifact_id = n.artifact_id AND s.key = n.key WHERE n.artifact_id = ? AND s.kind = 'push' AND n.data_json IS NOT NULL",
    )
    .all(id))
    out[String(r.key)] = JSON.parse(String(r.data_json)) as Json;
  return out;
}

export interface ListQuery {
  galleries: readonly string[];
  status?: "active" | "archived";
  q?: string;
  limit: number;
  cursor?: string;
  /** owner filters (gallery_view) */
  filter?: "all" | "review" | "shared" | "stale" | "archived";
}
const encodeCursor = (updatedAt: number, id: string) => Buffer.from(`${updatedAt}:${id}`, "utf8").toString("base64url");
function decodeCursor(c: string): { updatedAt: number; id: string } {
  const [t, id] = Buffer.from(c, "base64url").toString("utf8").split(":");
  if (!t || !id || !/^\d+$/.test(t)) throw new TbError("cursor_invalid", "cursor is not valid", 400);
  return { updatedAt: Number(t), id };
}
const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export function listArtifacts(db: Db, q: ListQuery, now: number): { items: Summary[]; nextCursor: string | null } {
  if (q.galleries.length === 0) return { items: [], nextCursor: null };
  const where: string[] = [`gallery_id IN (${q.galleries.map(() => "?").join(", ")})`];
  const args: unknown[] = [...q.galleries];
  const status = q.filter === "archived" ? "archived" : (q.status ?? (q.filter ? "active" : undefined));
  if (status) {
    where.push("status = ?");
    args.push(status);
  }
  if (q.q) {
    where.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
    args.push(like(q.q), like(q.q));
  }
  if (q.filter === "review")
    where.push(
      "(staged_version IS NOT NULL OR refresh_state = 'waiting_approval' OR EXISTS (SELECT 1 FROM la_source s WHERE s.artifact_id = la_artifact.id AND s.kind = 'read' AND (s.approved_digest IS NULL OR s.approved_digest <> s.digest)))",
    );
  if (q.filter === "shared") {
    where.push("EXISTS (SELECT 1 FROM la_link l WHERE l.artifact_id = la_artifact.id AND l.kind = 'viewer' AND l.revoked_at IS NULL AND l.expires_at > ?)");
    args.push(now);
  }
  if (q.filter === "stale") where.push("refresh_state IN ('paused', 'paused_error')");
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    where.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
    args.push(c.updatedAt, c.updatedAt, c.id);
  }
  const rows = db.prepare(`SELECT * FROM la_artifact WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT ?`).all(...args, q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => toSummary(db, r, now)),
    nextCursor: rows.length > q.limit && last ? encodeCursor(Number(last.updated_at), String(last.id)) : null,
  };
}

export function countByGallery(db: Db, galleries: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  if (galleries.length === 0) return m;
  for (const r of db
    .prepare(`SELECT gallery_id, COUNT(*) AS c FROM la_artifact WHERE gallery_id IN (${galleries.map(() => "?").join(", ")}) GROUP BY gallery_id`)
    .all(...galleries))
    m.set(String(r.gallery_id), Number(r.c));
  return m;
}

export function activityOf(db: Db, id: string, limit = 50) {
  return db
    .prepare("SELECT * FROM la_activity WHERE artifact_id = ? ORDER BY at DESC, id DESC LIMIT ?")
    .all(id, limit)
    .map((r) => ({ at: isoNow(Number(r.at)), action: String(r.action), by: actorOf(r, "by"), summary: String(r.summary) }));
}

// ─────────────────────────────────────────────────────────── settings

export function getSettings(db: Db): { defaultLinkDays: number } {
  const r = db.prepare("SELECT value FROM la_setting WHERE key = 'default_link_days'").get();
  return { defaultLinkDays: r ? Number(r.value) : LIMITS.defaultLinkDays };
}
export function setSettings(db: Db, s: { defaultLinkDays: number }): { defaultLinkDays: number } {
  db.prepare("INSERT INTO la_setting (key, value) VALUES ('default_link_days', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(s.defaultLinkDays));
  return getSettings(db);
}

// ─────────────────────────────────────────────────────────── writes

export function logActivity(db: Db, artifactId: string, action: string, by: Actor, summary: string, now: number): void {
  db.prepare("INSERT INTO la_activity (id, artifact_id, at, action, by_type, by_id, by_name, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    `act_${ulid(now)}`,
    artifactId,
    now,
    action,
    by.type,
    by.id,
    by.name,
    summary.slice(0, 280),
  );
}

const SANITIZE_LIMITS_TEXT = "256 nested elements, 256 attributes on one tag and 200,000 tags";
function insertVersion(db: Db, id: string, n: number, html: string, contract: Contract, by: Actor, note: string, now: number): void {
  const bytes = Buffer.from(html, "utf8");
  const cj = contractJson(contract);
  // sanitize ONCE, here: the viewer serves the stored result (S6 review: a bomb must not cost CPU on the serve path)
  let served: Buffer;
  try {
    served = Buffer.from(sanitizeHtml(html).html, "utf8");
  } catch (e) {
    throw new TbError("view_not_servable", `this page cannot be shown: ${e instanceof Error ? e.message : "it could not be checked"}. Keep it below ${SANITIZE_LIMITS_TEXT}.`, 422);
  }
  db.prepare(
    `INSERT INTO la_version (artifact_id, n, html, html_sha256, contract_json, contract_sha256, bytes, created_by_type, created_by_id, created_by_name, note, created_at, served_html, sanitizer_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, n, bytes, sha256Bytes(bytes), JSON.stringify(cj), digest(cj), bytes.length, by.type, by.id, by.name, note, now, served, SANITIZER_VERSION);
}

/** Keep the newest LIMITS.versionsKept versions plus the live, the staged and every version pinned by a link. */
export function pruneVersions(db: Db, id: string, now: number): number {
  const r = db
    .prepare(
      `DELETE FROM la_version WHERE artifact_id = ?1
         AND n NOT IN (SELECT n FROM la_version WHERE artifact_id = ?1 ORDER BY n DESC LIMIT ?2)
         AND n <> (SELECT live_version FROM la_artifact WHERE id = ?1)
         AND n <> COALESCE((SELECT staged_version FROM la_artifact WHERE id = ?1), -1)
         AND n NOT IN (SELECT pin_version FROM la_link WHERE artifact_id = ?1 AND pin_version IS NOT NULL AND revoked_at IS NULL AND expires_at > ?3)`,
    )
    .run(id, LIMITS.versionsKept, now);
  return Number(r.changes);
}

/** Bring la_source in line with a contract. Unchanged binding = approval kept; changed = pending again (viewers off);
 *  removed = row and snapshot deleted. Push sources need no owner approval (the agent's own data). */
function syncSources(db: Db, id: string, contract: Contract, now: number): void {
  const keep = new Set(contract.inputs.map((i) => i.key));
  for (const r of db.prepare("SELECT key FROM la_source WHERE artifact_id = ?").all(id)) {
    const key = String(r.key);
    if (keep.has(key)) continue;
    db.prepare("DELETE FROM la_source WHERE artifact_id = ? AND key = ?").run(id, key);
    db.prepare("DELETE FROM la_snapshot WHERE artifact_id = ? AND key = ?").run(id, key);
  }
  for (const i of contract.inputs) upsertSource(db, id, i, now);
}
function upsertSource(db: Db, id: string, i: ContractInput, now: number): void {
  const d = sourceDigest(i);
  const old = db.prepare("SELECT digest, kind FROM la_source WHERE artifact_id = ? AND key = ?").get(id, i.key);
  const product = i.kind === "read" ? i.product : null;
  const op = i.kind === "read" ? i.op : null;
  const input = i.kind === "read" ? JSON.stringify(i.input) : null;
  const projection = i.kind === "read" ? JSON.stringify(i.projection) : null;
  if (old && String(old.digest) === d) {
    db.prepare("UPDATE la_source SET label = ? WHERE artifact_id = ? AND key = ?").run(i.label, id, i.key);
    return;
  }
  if (old) {
    // changed binding: pending again, link viewers off, old data dropped (it came from the old binding)
    db.prepare(
      "UPDATE la_source SET kind = ?, label = ?, product = ?, op = ?, input_json = ?, projection_json = ?, digest = ?, approved_digest = ?, approved_by = ?, approved_at = ?, viewers = 0 WHERE artifact_id = ? AND key = ?",
    ).run(i.kind, i.label, product, op, input, projection, d, i.kind === "push" ? d : null, i.kind === "push" ? "auto" : null, i.kind === "push" ? now : null, id, i.key);
    db.prepare("DELETE FROM la_snapshot WHERE artifact_id = ? AND key = ?").run(id, i.key);
    return;
  }
  db.prepare(
    `INSERT INTO la_source (artifact_id, key, kind, label, product, op, input_json, projection_json, digest, approved_digest, approved_by, approved_at, viewers)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(id, i.key, i.kind, i.label, product, op, input, projection, d, i.kind === "push" ? d : null, i.kind === "push" ? "auto" : null, i.kind === "push" ? now : null);
}

/** Refresh columns for a contract: a schedule waits for the owner; an approved one keeps running if unchanged. */
/** Refresh columns for a contract. An approved schedule stays approved (with the OWNER's interval) while the agent's
 *  proposal is unchanged; a new proposal waits for the owner again (review PR #3, finding 8: compare proposal with
 *  proposal, never with the owner's lowered value). */
function scheduleColumns(contract: Contract, prev?: Row): { every: number | null; proposed: number | null; approved: number; state: string } {
  const proposed = contract.schedule?.everySeconds ?? null;
  if (proposed === null) return { every: null, proposed: null, approved: 0, state: "off" };
  if (prev && Number(prev.refresh_approved) === 1 && prev.refresh_proposed_s !== null && Number(prev.refresh_proposed_s) === proposed)
    return { every: Number(prev.refresh_every_s), proposed, approved: 1, state: String(prev.refresh_state) };
  return { every: proposed, proposed, approved: 0, state: "waiting_approval" };
}

export function assertCapacity(db: Db, gallery: string): void {
  const all = Number(db.prepare("SELECT COUNT(*) AS c FROM la_artifact").get()?.c ?? 0);
  if (all >= LIMITS.artifactsPerWorkspace) throw new TbError("limit_reached", `at most ${LIMITS.artifactsPerWorkspace} live pages in a workspace`, 409);
  const inGallery = Number(db.prepare("SELECT COUNT(*) AS c FROM la_artifact WHERE gallery_id = ?").get(gallery)?.c ?? 0);
  if (inGallery >= LIMITS.artifactsPerGallery) throw new TbError("limit_reached", `at most ${LIMITS.artifactsPerGallery} live pages in one gallery`, 409);
}
export function assertHtml(html: string): void {
  if (utf8Bytes(html) > LIMITS.htmlBytes) throw new TbError("html_too_large", `the page is larger than ${LIMITS.htmlBytes / 1024} KiB`, 413);
}

export interface CreateArgs {
  gallery: string;
  title: string;
  description: string;
  contract: Contract;
  html: string;
  note: string;
  by: Actor;
  origin: { kind: "agent" | "app" | "owner" | "copy"; ref: string | null };
  forkedFrom: string | null;
}
export function createArtifact(db: Db, a: CreateArgs, now: number): { id: string; version: number } {
  assertHtml(a.html);
  const id = `art_${ulid(now)}`;
  const s = scheduleColumns(a.contract);
  db.transaction(() => {
    assertCapacity(db, a.gallery);
    db.prepare(
      `INSERT INTO la_artifact (id, gallery_id, title, description, status, live_version, staged_version, auto_publish, refresh_every_s, refresh_proposed_s, refresh_approved, refresh_state,
         created_by_type, created_by_id, created_by_name, origin_kind, origin_ref, forked_from, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', 1, NULL, 'owner', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, a.gallery, a.title, a.description, s.every, s.proposed, s.approved, s.state, a.by.type, a.by.id, a.by.name, a.origin.kind, a.origin.ref, a.forkedFrom, now, now);
    insertVersion(db, id, 1, a.html, a.contract, a.by, a.note, now);
    for (const i of a.contract.inputs) upsertSource(db, id, i, now);
    logActivity(db, id, "artifact.create", a.by, `version 1: ${a.title}`, now);
  });
  return { id, version: 1 };
}

export interface UpdateArgs {
  expectedVersion?: number;
  title?: string;
  description?: string;
  contract?: Contract;
  html?: string;
  note: string;
  by: Actor;
}
/** The version an update builds on: the staged one if any, else the live one (never a rolled-back newer version). */
export function baseVersion(a: Row): number {
  return a.staged_version !== null ? Number(a.staged_version) : Number(a.live_version);
}

/** Make the sources and the schedule follow a contract that is going LIVE (staged contracts touch nothing live). */
function applyContract(db: Db, id: string, contract: Contract, prev: Row, now: number): void {
  syncSources(db, id, contract, now);
  const s = scheduleColumns(contract, prev);
  db.prepare("UPDATE la_artifact SET refresh_every_s = ?, refresh_proposed_s = ?, refresh_approved = ?, refresh_state = ? WHERE id = ?").run(s.every, s.proposed, s.approved, s.state, id);
}

export function updateArtifact(db: Db, id: string, u: UpdateArgs, now: number): { version: number; liveVersion: number; staged: boolean } {
  if (u.html !== undefined) assertHtml(u.html);
  return db.transaction(() => {
    const a = artifactRow(db, id);
    if (!a) throw notFound();
    if (String(a.status) !== "active") throw new TbError("artifact_archived", "this live page is archived; the owner can restore it", 409);
    const baseN = baseVersion(a);
    if (u.expectedVersion !== undefined && u.expectedVersion !== baseN)
      throw new TbError("version_conflict", `the page changed since version ${u.expectedVersion} (it is now version ${baseN}); read it again`, 409);
    const base = versionRow(db, id, baseN);
    if (!base) throw notFound();
    const baseHtml = Buffer.from(base.html as Uint8Array).toString("utf8");
    const staged = activeLinkCount(db, id, now) > 0 && String(a.auto_publish) === "owner";
    let version = baseN;
    let live = Number(a.live_version);
    const htmlChanged = u.html !== undefined && u.html !== baseHtml;
    const contractChanged = u.contract !== undefined && digest(contractJson(u.contract)) !== String(base.contract_sha256);
    if (htmlChanged || contractChanged) {
      version = newestVersion(db, id) + 1;
      const contract = u.contract ?? parseStoredContract(String(base.contract_json));
      insertVersion(db, id, version, u.html ?? baseHtml, contract, u.by, u.note, now);
      if (staged) db.prepare("UPDATE la_artifact SET staged_version = ? WHERE id = ?").run(version, id);
      else {
        live = version;
        db.prepare("UPDATE la_artifact SET live_version = ?, staged_version = NULL WHERE id = ?").run(version, id);
        // going live: the sources ALWAYS follow the live version's contract (a contract staged earlier may differ from
        // the live sources even when this update changes only the HTML; re-review finding 4)
        applyContract(db, id, contract, a, now);
      }
      pruneVersions(db, id, now);
    }
    if (u.title !== undefined || u.description !== undefined) {
      if (staged)
        db.prepare("UPDATE la_artifact SET staged_title = COALESCE(?, staged_title), staged_description = COALESCE(?, staged_description) WHERE id = ?").run(
          u.title ?? null,
          u.description ?? null,
          id,
        );
      else db.prepare("UPDATE la_artifact SET title = COALESCE(?, title), description = COALESCE(?, description) WHERE id = ?").run(u.title ?? null, u.description ?? null, id);
    }
    db.prepare("UPDATE la_artifact SET updated_at = ? WHERE id = ?").run(now, id);
    logActivity(db, id, "artifact.update", u.by, version !== baseN ? `version ${version}${staged ? " (staged)" : ""}` : staged ? "details (staged)" : "details", now);
    return { version, liveVersion: live, staged };
  });
}

export function deleteArtifact(db: Db, id: string, by: Actor, now: number): { deleted: boolean; linksRevoked: number } {
  return db.transaction(() => {
    if (!artifactRow(db, id)) return { deleted: false, linksRevoked: 0 };
    const links = activeLinkCount(db, id, now);
    db.prepare("DELETE FROM la_view_day WHERE link_id IN (SELECT id FROM la_link WHERE artifact_id = ?)").run(id);
    for (const t of ["la_link", "la_snapshot", "la_source", "la_version", "la_activity"]) db.prepare(`DELETE FROM ${t} WHERE artifact_id = ?`).run(id);
    db.prepare("DELETE FROM la_artifact WHERE id = ?").run(id);
    void by;
    return { deleted: true, linksRevoked: links };
  });
}

export function putData(db: Db, id: string, key: string, data: Json, by: Actor, now: number): { key: string; bytes: number; digest: string; staged: boolean } {
  let text: string;
  let d: string;
  try {
    text = JSON.stringify(data);
    d = digest(data);
  } catch {
    throw new TbError("data_invalid", "data cannot be stored (too deeply nested?)", 400);
  }
  const bytes = utf8Bytes(text);
  if (bytes > LIMITS.snapshotBytes) throw new TbError("data_too_large", `data is larger than ${LIMITS.snapshotBytes / 1024} KiB`, 413);
  return db.transaction(() => {
    const a = artifactRow(db, id);
    if (!a) throw notFound();
    if (String(a.status) !== "active") throw new TbError("artifact_archived", "this live page is archived; the owner can restore it", 409);
    const s = db.prepare("SELECT kind FROM la_source WHERE artifact_id = ? AND key = ?").get(id, key);
    if (!s) throw new TbError("source_unknown", `the page has no source "${key}"`, 404);
    if (String(s.kind) !== "push") throw new TbError("source_not_push", `source "${key}" is a read source; only push sources take data`, 409);
    const other = Number(
      // bytes, not characters: LENGTH() of TEXT counts characters (review PR #1, finding 4)
      db
        .prepare(
          "SELECT COALESCE(SUM(LENGTH(CAST(COALESCE(data_json, '') AS BLOB)) + LENGTH(CAST(COALESCE(staged_json, '') AS BLOB))), 0) AS b FROM la_snapshot WHERE artifact_id = ? AND key <> ?",
        )
        .get(id, key)?.b ?? 0,
    );
    const mine = db.prepare("SELECT data_json FROM la_snapshot WHERE artifact_id = ? AND key = ?").get(id, key);
    const staged = activeLinkCount(db, id, now) > 0 && String(a.auto_publish) === "owner";
    const keptLive = staged && mine?.data_json ? utf8Bytes(String(mine.data_json)) : 0;
    if (other + keptLive + bytes > LIMITS.artifactDataBytes) throw new TbError("data_too_large", `all data of one page is limited to ${LIMITS.artifactDataBytes / 1024} KiB`, 413);
    if (staged)
      db.prepare(
        `INSERT INTO la_snapshot (artifact_id, key, staged_json, bytes, digest, status, pushed_by_id, pushed_by_name) VALUES (?, ?, ?, ?, ?, 'empty', ?, ?)
         ON CONFLICT (artifact_id, key) DO UPDATE SET staged_json = excluded.staged_json, pushed_by_id = excluded.pushed_by_id, pushed_by_name = excluded.pushed_by_name`,
      ).run(id, key, text, bytes, d, by.id, by.name);
    else
      db.prepare(
        `INSERT INTO la_snapshot (artifact_id, key, data_json, bytes, digest, fetched_at, status, code, pushed_by_id, pushed_by_name) VALUES (?, ?, ?, ?, ?, ?, 'ok', NULL, ?, ?)
         ON CONFLICT (artifact_id, key) DO UPDATE SET data_json = excluded.data_json, staged_json = NULL, bytes = excluded.bytes, digest = excluded.digest,
           fetched_at = excluded.fetched_at, status = 'ok', code = NULL, pushed_by_id = excluded.pushed_by_id, pushed_by_name = excluded.pushed_by_name`,
      ).run(id, key, text, bytes, d, now, by.id, by.name);
    db.prepare("UPDATE la_artifact SET updated_at = ? WHERE id = ?").run(now, id);
    logActivity(db, id, "data.put", by, `${key}: ${bytes} bytes${staged ? " (staged)" : ""}`, now);
    return { key, bytes, digest: d, staged };
  });
}

/** Staged pushed data to publish with a version: all of it (owner), or the listed keys, each bound to the digest the
 *  agent saw (an agent publish: what the owner approved is what goes live). */
export type PublishData = boolean | readonly { key: string; digest: string }[];

/** What an agent publish is bound to (the owner approved exactly this): the version's sha256, and the staged title and/or
 *  description to promote with it. A staged title or description that is not listed here stays staged. */
export interface PublishExpect {
  htmlSha256: string;
  title?: string | undefined;
  description?: string | undefined;
}
export const pageChanged = (what: string): TbError => new TbError("page_changed", `${what} changed after you asked; read the page again and ask again`, 409);

/** Make a version live (promote the staged one or roll back) and publish staged pushed data (see PublishData). The
 *  owner's call (no `expect`) also promotes the staged title and description; an agent's call promotes only what its
 *  `expect` lists and the owner saw, and refuses with page_changed when anything differs (all checks before any change). */
export function publishVersion(db: Db, id: string, n: number, data: PublishData, by: Actor, now: number, expect?: PublishExpect): { liveVersion: number; publishedKeys: string[] } {
  return db.transaction(() => {
    const a = artifactRow(db, id);
    if (!a) throw notFound();
    const v = versionRow(db, id, n);
    if (!v) throw new TbError("version_unknown", `version ${n} does not exist (it may have been pruned)`, 404);
    const stagedN0 = a.staged_version === null ? null : Number(a.staged_version);
    const goesWithVersion = stagedN0 === null || stagedN0 === n;
    let promoteTitle = expect === undefined;
    let promoteDescription = expect === undefined;
    if (expect) {
      if (String(v.html_sha256) !== expect.htmlSha256) throw pageChanged(`version ${n}`);
      for (const [field, want, staged] of [
        ["title", expect.title, a.staged_title],
        ["description", expect.description, a.staged_description],
      ] as const) {
        if (want === undefined) continue;
        if (staged === null || String(staged) !== want) throw pageChanged(`the staged ${field}`);
        if (!goesWithVersion) throw new TbError("page_changed", `the staged ${field} goes live only with its own version; it is not part of this change`, 409);
      }
      promoteTitle = expect.title !== undefined;
      promoteDescription = expect.description !== undefined;
    }
    // listed data must still be what the agent asked for: checked BEFORE any change
    const chosen: string[] = [];
    if (typeof data !== "boolean") {
      for (const d of data) {
        const r = db.prepare("SELECT staged_json FROM la_snapshot WHERE artifact_id = ? AND key = ? AND staged_json IS NOT NULL").get(id, d.key);
        if (!r || digest(JSON.parse(String(r.staged_json)) as Json) !== d.digest)
          throw new TbError("staged_changed", `the staged data of "${d.key}" changed after you asked (or is gone); read the page again and ask again`, 409);
        chosen.push(d.key);
      }
    }
    const stagedN = stagedN0;
    const keepStaged = stagedN !== null && stagedN !== n && stagedN > n;
    db.prepare("UPDATE la_artifact SET live_version = ?, staged_version = ?, updated_at = ? WHERE id = ?").run(n, keepStaged ? stagedN : null, now, id);
    if (goesWithVersion && promoteTitle) db.prepare("UPDATE la_artifact SET title = COALESCE(staged_title, title), staged_title = NULL WHERE id = ?").run(id);
    if (goesWithVersion && promoteDescription) db.prepare("UPDATE la_artifact SET description = COALESCE(staged_description, description), staged_description = NULL WHERE id = ?").run(id);
    // the live version's contract decides sources and schedule (unchanged bindings keep their approval)
    applyContract(db, id, parseStoredContract(String(v.contract_json)), a, now);
    const keys: string[] = [];
    if (data !== false) {
      for (const r of db.prepare("SELECT key, staged_json FROM la_snapshot WHERE artifact_id = ? AND staged_json IS NOT NULL").all(id)) {
        if (typeof data !== "boolean" && !chosen.includes(String(r.key))) continue;
        const text = String(r.staged_json);
        db.prepare(
          "UPDATE la_snapshot SET data_json = staged_json, staged_json = NULL, bytes = ?, digest = ?, fetched_at = ?, status = 'ok', code = NULL WHERE artifact_id = ? AND key = ?",
        ).run(utf8Bytes(text), digest(JSON.parse(text) as Json), now, id, r.key);
        keys.push(String(r.key));
      }
    }
    pruneVersions(db, id, now);
    logActivity(db, id, "version.publish", by, `version ${n} live${keys.length ? `; data ${keys.join(", ")}` : ""}`, now);
    return { liveVersion: n, publishedKeys: keys };
  });
}

export function setAutoPublish(db: Db, id: string, mode: "owner" | "agent", by: Actor, now: number): void {
  const r = db.prepare("UPDATE la_artifact SET auto_publish = ?, updated_at = ? WHERE id = ?").run(mode, now, id);
  if (r.changes === 0) throw notFound();
  logActivity(db, id, "autopublish.set", by, mode, now);
}
export function setArchived(db: Db, id: string, archived: boolean, by: Actor, now: number): "active" | "archived" {
  const status = archived ? "archived" : "active";
  const r = db.prepare("UPDATE la_artifact SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
  if (r.changes === 0) throw notFound();
  logActivity(db, id, archived ? "artifact.archive" : "artifact.restore", by, status, now);
  return status;
}
