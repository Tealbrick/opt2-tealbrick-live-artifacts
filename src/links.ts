// Viewer links (S4, DESIGN §3.1, §3.2, §4.1, §4.7, §5.2): create, revoke, list, and the texts the owner reads on a hold.
// A link is a random bearer token (viewer.ts newToken); only its sha256 is stored. Expiry and revocation are checked on
// every request by the viewer path (viewer.ts usableLink), so a revoke is immediate. One state change = one transaction.
import { digest, opaqueDigest, ulid } from "@opt2-tealbrick/manifest";
import { type Db, type Json, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { parseStoredContract, sourceDigest } from "./contract.ts";
import { type ShareExpect, shareMismatch, versionRunsScripts, visiblePushData } from "./expect.ts";
import { LIMITS } from "./limits.ts";
import { RUNS_SCRIPTS_SENTENCE } from "./scripts-text.ts";
import { type Actor, activeLinkCount, artifactRow, getSettings, logActivity, notFound, type PublishExpect, pageChanged, versionRow } from "./store.ts";
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
  /** an agent's link: the page the owner approved (the version it shows, its sha256 and the title); refused with
   *  page_changed when the page is not exactly that any more. The owner's own link has no `expect`. */
  expect?: ShareExpect | undefined;
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
    if (a.expect) {
      const diff = shareMismatch(db, a.artifactId, pin, a.expect);
      if (diff.length > 0) throw pageChanged(`the page (${diff.join(", ")})`);
    }
    if (activeLinkCount(db, a.artifactId, now) >= LIMITS.linksPerArtifact)
      throw new TbError("links_limit_artifact", `a page has at most ${LIMITS.linksPerArtifact} active links; revoke one first`, 409);
    if (activeWorkspaceLinks(db, now) >= LIMITS.linksPerWorkspace) throw new TbError("links_limit_workspace", `a workspace has at most ${LIMITS.linksPerWorkspace} active links; revoke one first`, 409);
    // links that ended long ago go (their view counts with them); previews are cleaned up by the viewer path
    const cutoff = now - LIMITS.endedLinkKeepDays * DAY_MS;
    const old = "SELECT id FROM la_link WHERE kind = 'viewer' AND ((revoked_at IS NOT NULL AND revoked_at < ?1) OR (revoked_at IS NULL AND expires_at < ?1))";
    db.prepare(`DELETE FROM la_view_day WHERE link_id IN (${old})`).run(cutoff);
    db.prepare(`DELETE FROM la_link WHERE id IN (${old})`).run(cutoff);
    // approved for scripts only if the page it shows runs scripts now (an agent link: bound by expect.runsScripts above)
    const shownV = versionRow(db, a.artifactId, pin ?? Number(art.live_version));
    const scriptsOk = shownV !== undefined && versionRunsScripts(shownV) ? 1 : 0;
    const token = newToken();
    const id = `lnk_${ulid(now)}`;
    const expiresAt = now + days * DAY_MS;
    db.prepare(
      `INSERT INTO la_link (id, artifact_id, kind, token_digest, label, created_by_type, created_by_id, created_by_name, created_at, expires_at, pin_version, scripts_ok)
       VALUES (?, ?, 'viewer', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, a.artifactId, opaqueDigest(token), a.label, a.by.type, a.by.id, a.by.name, now, expiresAt, pin, scriptsOk);
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
      /** the link may run the page's scripts (the owner approved it for a page that runs scripts) */
      runsScripts: Number(r.scripts_ok) === 1,
      status: statusOf(r, now),
    }));
  return { items, active: activeWorkspaceLinks(db, now) };
}

// ─────────────────────────────────────────────────────────── hold texts (DESIGN T4, §3.1)

const KIB = 1024;
/** Agent-written text (titles, labels, names) in a hold: one line, no control or invisible format characters, so it cannot
 *  fake lines of the hold text or hide in it. */
const clip = (s: string, n: number): string => {
  const one = s.replace(/\p{Cf}+/gu, "").replace(/[\p{Cc}\u2028\u2029]+/gu, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
/** A clipped agent text as a JSON string, so quotes and backslashes in it cannot end the quotation. */
const quote = (s: string, n: number): string => JSON.stringify(clip(s, n));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const kib = (bytes: number): string => `${Math.max(1, Math.round(bytes / KIB))} KiB`;
/** "sha256:<hex>" → its first 16 hex digits, enough for the owner to compare with what the agent reports. */
const shortDigest = (d: string): string => `${d.replace(/^sha256:/, "").slice(0, 16)}…`;
const NAME_MAX = 60;

export { RUNS_SCRIPTS_SENTENCE };

/** One source in the words the owner reads: its quoted label and what it is (all agent-written text is quoted). */
function sourceLine(s: Row): string {
  const label = quote(String(s.label || s.key), 60);
  return s.kind === "push" ? `${label} (data pushed by an agent)` : `${label} (${quote(String(s.product), 32)} ${quote(String(s.op), 64)})`;
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
const versionLine = (n: number, v: Row): string => `Version ${n}: ${kib(Number(v.bytes))}, sha256 ${shortDigest(String(v.html_sha256))}, written by ${quote(String(v.created_by_name), NAME_MAX)}.`;

export interface ShareHoldInput {
  id: string;
  label?: string | undefined;
  expiresInDays?: number | undefined;
  pin?: number | null | undefined;
  expect?: ShareExpect | undefined;
}
/** What the owner reads before approving `artifact_share`: the page (title, version, size, sha256, author), who gets it,
 *  how long, which data. `viewerMissing`: the app saw that the bridge has no viewer address (the SDK gives a hold view
 *  only the input, so this is the last answer seen on any call). A request that is not the page as it is now starts with
 *  "Do not approve" (and the app refuses it when it runs, whatever the page is by then). */
export function shareHoldText(db: Db, i: ShareHoldInput, now: number, opts: { viewerMissing?: boolean } = {}): string {
  const a = artifactRow(db, i.id);
  if (!a) return `Create a public link to the live page ${i.id}.`;
  const days = i.expiresInDays ?? getSettings(db).defaultLinkDays;
  const { shown, hidden } = sourcesShown(db, i.id);
  const pin = i.pin ?? null;
  const live = Number(a.live_version);
  const staged = a.staged_version === null ? null : Number(a.staged_version);
  const showsN = pin ?? live;
  const v = versionRow(db, i.id, showsN);
  const have = activeLinkCount(db, i.id, now);
  const e = i.expect;
  const diff = e ? shareMismatch(db, i.id, pin, e) : [];
  const lines: string[] = [];
  if (diff.length > 0) lines.push("Do not approve: this is not the page as it is now.");
  if (opts.viewerMissing) lines.push("This page cannot be shared yet (no viewer address); approving changes nothing.");
  lines.push(
    `Create a public link to the live page ${quote(String(a.title), 80)}, made by ${quote(String(a.created_by_name), NAME_MAX)}.`,
    `Anyone who has the link can open the page without an account. The link ends ${plural(days, "day")} after you approve${i.label ? ` (label: ${quote(i.label, 40)})` : ""}. You can revoke it at any time.`,
  );
  if (pin === null) lines.push(`The link follows the live version of the page (now version ${live}) and every version you make live.`);
  else lines.push(`The link shows the page code of version ${pin} only: the page code stays at version ${pin}; title and data still follow updates you approve.`);
  if (!v) lines.push(`Version ${showsN} does not exist (it may have been pruned). The call will be refused.`);
  else {
    lines.push(versionLine(showsN, v));
    if (pin !== null && staged === pin) lines.push(`Version ${pin} has not been reviewed yet: it is staged and waits for you. It is not live.`);
    else if (pin !== null && pin > live) lines.push(`Version ${pin} is newer than the live version (now version ${live}) and has not been reviewed yet.`);
    else if (pin !== null && pin < live) lines.push(`Version ${pin} is older than the live version (now version ${live}).`);
  }
  if (String(a.auto_publish) === "agent") lines.push("At the time of this request: later agent changes go live on this link WITHOUT your approval (you allowed that for this page).");
  if (e) {
    lines.push(
      diff.length === 0
        ? "The agent saw exactly this page, this data and these data sources. If any of it changes before the call runs, the call is refused (page_changed)."
        : `The agent saw something else (it differs in: ${diff.join(", ")}). The agent asked for version ${e.version}, sha256 ${shortDigest(e.htmlSha256)}, title ${quote(e.title, 80)}. The call is refused (page_changed), whatever the page is later.`,
    );
  }
  lines.push(
    `The page shows these data sources to people with the link: ${listOr(shown, "none (it shows no data from your apps)")}.`,
    `It does not show: ${listOr(hidden, "nothing else")}.`,
  );
  // the pushed data link viewers would see, exactly as it is now (the call is bound to it)
  for (const d of visiblePushData(db, i.id)) {
    lines.push(`Pushed data ${quote(d.label, 60)} (key ${d.key}) is shown as it is now: ${d.sha256 === "none" ? "no data yet" : `${kib(d.bytes)}, sha256 ${shortDigest(d.sha256)}`}.`);
  }
  if (v && versionRunsScripts(v)) {
    lines.push(
      RUNS_SCRIPTS_SENTENCE,
      "The page cannot read your Tealbrick data or session. A viewer can still copy what is on screen.",
    );
  } else if (v) {
    lines.push(
      "This page runs no scripts. The link shows it without scripts, also if a later version of the page gains scripts. The page cannot read your Tealbrick data or session. A viewer can still copy what is on screen.",
    );
  }
  lines.push(
    `At the time of this request ${plural(have, "link")} of this page ${have === 1 ? "is" : "are"} active (at most ${LIMITS.linksPerArtifact}).`,
  );
  return lines.join("\n");
}

export interface PublishHoldInput {
  id: string;
  version: number;
  data?: readonly { key: string; digest: string }[] | undefined;
  expect?: PublishExpect | undefined;
}
/** What differs between the page now and what an `artifact_publish` asks for; [] when the call would run. */
export function publishMismatch(db: Db, i: PublishHoldInput): string[] {
  const a = artifactRow(db, i.id);
  if (!a) return ["page"];
  const v = versionRow(db, i.id, i.version);
  if (!v) return ["version"];
  const out: string[] = [];
  const e = i.expect;
  if (e && e.htmlSha256 !== String(v.html_sha256)) out.push("page code");
  const staged = a.staged_version === null ? null : Number(a.staged_version);
  const goesWith = staged === null || staged === i.version;
  for (const [field, now_, want] of [
    ["title", a.staged_title, e?.title],
    ["description", a.staged_description, e?.description],
  ] as const) {
    if (want !== undefined && (now_ === null || String(now_) !== want || !goesWith)) out.push(`staged ${field}`);
  }
  for (const d of i.data ?? []) {
    const r = db.prepare("SELECT staged_json FROM la_snapshot WHERE artifact_id = ? AND key = ? AND staged_json IS NOT NULL").get(i.id, d.key);
    if (!r || digest(JSON.parse(String(r.staged_json)) as Json) !== d.digest) out.push(`staged data ${d.key}`);
  }
  return out;
}

/** What the owner reads before approving `artifact_publish`: what becomes visible to link holders, and what changes. */
export function publishHoldText(db: Db, i: PublishHoldInput, now: number): string {
  const a = artifactRow(db, i.id);
  if (!a) return `Change what the people who hold a link to ${i.id} see.`;
  const live = Number(a.live_version);
  const staged = a.staged_version === null ? null : Number(a.staged_version);
  const v = versionRow(db, i.id, i.version);
  const links = activeLinkCount(db, i.id, now);
  const e = i.expect;
  const lines = [`Change what ${links === 0 ? "viewers" : plural(links, "active link")} of the live page ${quote(String(a.title), 80)} show${links === 1 ? "s" : ""}.`];
  // a request that is not what the page is now is refused when it runs, whatever the page is by then
  if (publishMismatch(db, i).length > 0) lines.unshift("Do not approve: this is not the page as it is now.");
  if (!v) lines.push(`Version ${i.version} does not exist (it may have been pruned). The call will be refused.`);
  else {
    if (i.version === live) lines.push(`The live version stays version ${live}.`);
    else if (i.version < live) lines.push(`This rolls the page back from version ${live} to the older version ${i.version}.`);
    else if (staged === i.version) lines.push(`Version ${i.version} waits for you and becomes live now (version ${live} is live).`);
    else lines.push(`Version ${i.version} is not the staged version. It becomes live now (version ${live} is live).`);
    if (i.version !== live) {
      lines.push(versionLine(i.version, v));
      lines.push("Links that follow the live version show it at once; pinned links keep their version.");
      if (staged !== null && staged !== i.version) lines.push(`The staged version ${staged} stays staged and waits for you.`);
    }
    if (versionRunsScripts(v)) lines.push(RUNS_SCRIPTS_SENTENCE, "Links approved without scripts keep showing the page without scripts.");
    if (e && e.htmlSha256 !== String(v.html_sha256)) lines.push(`The agent saw sha256 ${shortDigest(e.htmlSha256)}. That is not version ${i.version} as it is now; the call will be refused (page_changed).`);
    // title and description: an agent's call moves only what it lists and what is shown here
    const goesWith = staged === null || staged === i.version;
    for (const [field, now_, want] of [
      ["title", a.staged_title, e?.title],
      ["description", a.staged_description, e?.description],
    ] as const) {
      if (now_ === null) {
        if (want !== undefined) lines.push(`The agent expects a staged ${field}, but none is staged; the call will be refused (page_changed).`);
        continue;
      }
      const text = quote(String(now_), field === "title" ? 80 : 280);
      if (want === undefined) lines.push(`The staged ${field} ${text} stays staged and waits for you.`);
      else if (want !== String(now_)) lines.push(`The agent expects another staged ${field} (${quote(want, 280)}); the call will be refused (page_changed).`);
      else if (!goesWith) lines.push(`The staged ${field} ${text} belongs to version ${staged}; the call will be refused (page_changed).`);
      else lines.push(`The staged ${field} ${text} goes live with it.`);
    }
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
