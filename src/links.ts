// Viewer links (S4, DESIGN §3.1, §3.2, §4.1, §4.7, §5.2): create, revoke, list, and the texts the owner reads on a hold.
// A link is a random bearer token (viewer.ts newToken); only its sha256 is stored. Expiry and revocation are checked on
// every request by the viewer path (viewer.ts usableLink), so a revoke is immediate. One state change = one transaction.
import { digest, opaqueDigest, ulid } from "@opt2-tealbrick/manifest";
import { type Db, type Json, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { parseStoredContract, sourceDigest } from "./contract.ts";
import { LIMITS } from "./limits.ts";
import { type Actor, activeLinkCount, artifactRow, getSettings, logActivity, notFound, versionRow } from "./store.ts";
import { newToken } from "./viewer.ts";

const DAY_MS = 86_400_000;
type Row = Record<string, unknown>;
const iso = (ms: unknown): string | null => (ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString());

export const LINK_ID_RE = /^lnk_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Active viewer links of the whole workspace (not expired, not revoked). Previews do not count. */
export function activeWorkspaceLinks(db: Db, now: number): number {
  return Number(db.prepare("SELECT COUNT(*) AS c FROM la_link WHERE kind = 'viewer' AND revoked_at IS NULL AND expires_at > ?").get(now)?.c ?? 0);
}

export interface CreateLinkArgs {
  artifactId: string;
  label: string;
  /** days until the link ends; absent = the owner's default (Settings) */
  expiresInDays?: number | undefined;
  /** a version number to show for the link's whole life; null or absent = follow the live version */
  pin?: number | null | undefined;
  by: Actor;
}
export interface CreatedLink {
  id: string;
  /** the bearer token; the caller builds the address from it and never stores it */
  token: string;
  expiresAt: number;
  pin: number | null;
}

/** Create a viewer link. Checks the page, the pin and the caps in one transaction. */
export function createLink(db: Db, a: CreateLinkArgs, now: number): CreatedLink {
  const days = a.expiresInDays ?? getSettings(db).defaultLinkDays;
  if (!Number.isInteger(days) || days < 1 || days > LIMITS.maxLinkDays) throw new TbError("link_days_invalid", `a link lasts 1 to ${LIMITS.maxLinkDays} days`, 400);
  return db.transaction(() => {
    const art = artifactRow(db, a.artifactId);
    if (!art) throw notFound();
    if (String(art.status) !== "active") throw new TbError("artifact_archived", "this live page is archived; the owner can restore it", 409);
    const pin = a.pin ?? null;
    if (pin !== null && !versionRow(db, a.artifactId, pin)) throw new TbError("version_unknown", `version ${pin} does not exist (it may have been pruned)`, 404);
    if (activeLinkCount(db, a.artifactId, now) >= LIMITS.linksPerArtifact)
      throw new TbError("links_limit_artifact", `a page has at most ${LIMITS.linksPerArtifact} active links; revoke one first`, 409);
    if (activeWorkspaceLinks(db, now) >= LIMITS.linksPerWorkspace) throw new TbError("links_limit_workspace", `a workspace has at most ${LIMITS.linksPerWorkspace} active links; revoke one first`, 409);
    // links that ended long ago go (their view counts with them); previews are cleaned up by the viewer path
    const cutoff = now - LIMITS.endedLinkKeepDays * DAY_MS;
    const old = "SELECT id FROM la_link WHERE kind = 'viewer' AND ((revoked_at IS NOT NULL AND revoked_at < ?1) OR (revoked_at IS NULL AND expires_at < ?1))";
    db.prepare(`DELETE FROM la_view_day WHERE link_id IN (${old})`).run(cutoff);
    db.prepare(`DELETE FROM la_link WHERE id IN (${old})`).run(cutoff);
    const token = newToken();
    const id = `lnk_${ulid(now)}`;
    const expiresAt = now + days * DAY_MS;
    db.prepare(
      `INSERT INTO la_link (id, artifact_id, kind, token_digest, label, created_by_type, created_by_id, created_by_name, created_at, expires_at, pin_version)
       VALUES (?, ?, 'viewer', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, a.artifactId, opaqueDigest(token), a.label, a.by.type, a.by.id, a.by.name, now, expiresAt, pin);
    logActivity(db, a.artifactId, "link.create", a.by, `${a.label ? `"${a.label}"` : "link"} for ${days} day${days === 1 ? "" : "s"}${pin === null ? "" : `, version ${pin}`}`, now);
    return { id, token, expiresAt, pin };
  });
}

/** The gallery of the page a viewer link belongs to, so the SDK checks access to THAT gallery. An unknown link maps to a
 *  gallery nobody holds (the same answer as a link of a gallery the caller cannot reach). */
export function galleryOfLink(db: Db, linkId: string, none: string): string {
  const r = db.prepare("SELECT a.gallery_id AS g FROM la_link l JOIN la_artifact a ON a.id = l.artifact_id WHERE l.id = ? AND l.kind = 'viewer'").get(linkId);
  return r ? String(r.g) : none;
}

/** Revoke a viewer link at once. Revoking a link that is already revoked or ended is a no-op that still answers true. */
export function revokeLink(db: Db, linkId: string, by: Actor, now: number): { revoked: boolean; artifactId: string } {
  return db.transaction(() => {
    const l = db.prepare("SELECT id, artifact_id, label, revoked_at FROM la_link WHERE id = ? AND kind = 'viewer'").get(linkId);
    if (!l) throw new TbError("link_not_found", "no such link", 404);
    if (l.revoked_at === null) {
      db.prepare("UPDATE la_link SET revoked_at = ? WHERE id = ?").run(now, linkId);
      logActivity(db, String(l.artifact_id), "link.revoke", by, String(l.label) ? `"${String(l.label)}"` : "link", now);
    }
    return { revoked: true, artifactId: String(l.artifact_id) };
  });
}

const statusOf = (r: Row, now: number): "active" | "expired" | "revoked" => (r.revoked_at !== null ? "revoked" : Number(r.expires_at) <= now ? "expired" : "active");

/** Every viewer link of every page, newest first (the Links page). Never an address (only digests are stored). */
export function listLinks(db: Db, now: number) {
  const items = db
    .prepare(
      `SELECT l.*, a.title AS artifact_title FROM la_link l JOIN la_artifact a ON a.id = l.artifact_id
        WHERE l.kind = 'viewer' ORDER BY l.created_at DESC, l.id DESC LIMIT ?`,
    )
    .all(LIMITS.linksListMax)
    .map((r) => ({
      id: String(r.id),
      artifactId: String(r.artifact_id),
      artifactTitle: String(r.artifact_title),
      label: String(r.label),
      createdBy: { type: String(r.created_by_type) as "agent" | "app" | "person", id: String(r.created_by_id), name: String(r.created_by_name) },
      createdAt: new Date(Number(r.created_at)).toISOString(),
      expiresAt: new Date(Number(r.expires_at)).toISOString(),
      revokedAt: iso(r.revoked_at),
      pinVersion: r.pin_version === null ? null : Number(r.pin_version),
      views: Number(r.views),
      lastSeenDay: r.last_seen_day === null ? null : String(r.last_seen_day),
      status: statusOf(r, now),
    }));
  return { items, active: activeWorkspaceLinks(db, now) };
}

// ─────────────────────────────────────────────────────────── hold texts (DESIGN T4, §3.1)

const KIB = 1024;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const kib = (bytes: number): string => `${Math.max(1, Math.round(bytes / KIB))} KiB`;
/** "sha256:<hex>" → its first 16 hex digits, enough for the owner to compare with what the agent reports. */
const shortDigest = (d: string): string => `${d.replace(/^sha256:/, "").slice(0, 16)}…`;

/** One source in the words the owner reads: its label and what it is. */
function sourceLine(s: Row): string {
  const label = clip(String(s.label || s.key), 60);
  return s.kind === "push" ? `${label} (data pushed by an agent)` : `${label} (${String(s.product)} ${String(s.op)})`;
}
/** Sources the viewer links of this page show (approved and marked "show to people with a link") and the ones they do not. */
function sourcesShown(db: Db, artifactId: string): { shown: string[]; hidden: string[] } {
  const shown: string[] = [];
  const hidden: string[] = [];
  for (const s of db.prepare("SELECT * FROM la_source WHERE artifact_id = ? ORDER BY rowid").all(artifactId)) {
    const approved = s.approved_digest !== null && s.approved_digest === s.digest;
    (approved && Number(s.viewers) === 1 ? shown : hidden).push(sourceLine(s));
  }
  return { shown, hidden };
}
const listOr = (items: string[], none: string): string => (items.length === 0 ? none : items.join("; "));

/** What the owner reads before approving `artifact_share`: the page, who gets it, how long, which version, which data. */
export function shareHoldText(db: Db, i: { id: string; label?: string | undefined; expiresInDays?: number | undefined; pin?: number | null | undefined }, now: number): string {
  const a = artifactRow(db, i.id);
  if (!a) return `Create a public link to the live page ${i.id}.`;
  const days = i.expiresInDays ?? getSettings(db).defaultLinkDays;
  const { shown, hidden } = sourcesShown(db, i.id);
  const pin = i.pin ?? null;
  const version =
    pin === null
      ? `It always shows the live version of the page (now version ${Number(a.live_version)}) and follows every update you approve.`
      : `It shows version ${pin} only, whatever happens to the page later.`;
  const have = activeLinkCount(db, i.id, now);
  return [
    `Create a public link to the live page "${clip(String(a.title), 80)}", made by ${String(a.created_by_name)}.`,
    `Anyone who has the link can open the page without an account. The link ends ${plural(days, "day")} after you approve${i.label ? ` (label: "${clip(i.label, 40)}")` : ""}. You can revoke it at any time.`,
    version,
    `The page shows these data sources to people with the link: ${listOr(shown, "none (it shows no data from your apps)")}.`,
    `It does not show: ${listOr(hidden, "nothing else")}.`,
    "Page code written by an AI agent runs in the viewer's browser without network access. A viewer can still copy what is on screen.",
    `${plural(have, "link")} of this page ${have === 1 ? "is" : "are"} active now (at most ${LIMITS.linksPerArtifact}).`,
  ].join("\n");
}

/** What the owner reads before approving `artifact_publish`: what becomes visible to link holders, and what changes. */
export function publishHoldText(db: Db, i: { id: string; version: number; data?: readonly { key: string; digest: string }[] | undefined }, now: number): string {
  const a = artifactRow(db, i.id);
  if (!a) return `Change what the people who hold a link to ${i.id} see.`;
  const live = Number(a.live_version);
  const staged = a.staged_version === null ? null : Number(a.staged_version);
  const v = versionRow(db, i.id, i.version);
  const links = activeLinkCount(db, i.id, now);
  const lines = [`Change what ${links === 0 ? "viewers" : plural(links, "active link")} of the live page "${clip(String(a.title), 80)}" show${links === 1 ? "s" : ""}.`];
  if (!v) lines.push(`Version ${i.version} does not exist (it may have been pruned). The call will be refused.`);
  else if (i.version === live) lines.push(`The live version stays version ${live}.`);
  else {
    const how = staged === i.version ? "the version that waits for you" : i.version < live ? "an older version (a rollback)" : "a version that is not staged";
    lines.push(`Version ${i.version} (${how}) becomes live; now version ${live} is live.`);
    lines.push(`Version ${i.version}: ${kib(Number(v.bytes))}, sha256 ${shortDigest(String(v.html_sha256))}, written by ${String(v.created_by_name)}. Links that follow the live version show it at once; pinned links keep their version.`);
    if (a.staged_title !== null || a.staged_description !== null) lines.push(`The staged title or description goes live with it${a.staged_title !== null ? `: "${clip(String(a.staged_title), 80)}"` : ""}.`);
    // sources the version's contract adds, drops or changes against what is live now
    const target = parseStoredContract(String(v.contract_json));
    const current = new Map(db.prepare("SELECT key, digest FROM la_source WHERE artifact_id = ?").all(i.id).map((r) => [String(r.key), String(r.digest)]));
    const added = target.inputs.filter((x) => !current.has(x.key)).map((x) => x.key);
    const changed = target.inputs.filter((x) => current.has(x.key) && current.get(x.key) !== sourceDigest(x)).map((x) => x.key);
    const removed = [...current.keys()].filter((k) => !target.inputs.some((x) => x.key === k));
    const parts = [
      added.length > 0 ? `adds ${added.join(", ")}` : "",
      changed.length > 0 ? `changes ${changed.join(", ")} (needs your approval before link viewers see it)` : "",
      removed.length > 0 ? `removes ${removed.join(", ")} with its data` : "",
    ].filter(Boolean);
    lines.push(`Data sources: ${parts.length === 0 ? "unchanged" : parts.join("; ")}.`);
  }
  const listed = i.data ?? [];
  if (listed.length === 0) lines.push("No staged data is published with it.");
  else
    for (const d of listed) {
      const r = db.prepare("SELECT staged_json FROM la_snapshot WHERE artifact_id = ? AND key = ? AND staged_json IS NOT NULL").get(i.id, d.key);
      let state = "nothing is staged under this key; the call will be refused";
      if (r) state = digest(JSON.parse(String(r.staged_json)) as Json) === d.digest ? `${kib(Buffer.byteLength(String(r.staged_json), "utf8"))}, digest ${shortDigest(d.digest)}` : "the staged data changed after it was asked for; the call will be refused";
      lines.push(`Pushed data "${d.key}" goes live: ${state}.`);
    }
  const { shown } = sourcesShown(db, i.id);
  lines.push(`People with a link see these data sources: ${listOr(shown, "none")}.`);
  return lines.join("\n");
}
