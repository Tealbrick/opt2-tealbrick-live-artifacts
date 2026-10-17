// What an agent link request is bound to (S4 review F1, F4). The owner approves a link for ONE page: the version it shows,
// that version's sha256, the title, the pushed data that link viewers see, and the list of data sources. The agent sends
// that as `expect` (artifact_get answers it ready-made as `shareExpect`); the call is refused with `page_changed` when
// the page is not exactly that when it runs. The same function judges the call in the hold text (a mismatch there makes a
// flagged "Do not approve" hold that never runs, la_hold_flag) and when the call runs, so the two can never disagree.
// There is no early refusal before the hold: the SDK access and pause checks come first for every caller (543880d).
import { digest } from "@opt2-tealbrick/manifest";
import type { Db, Json } from "@opt2-tealbrick/miniapp-sdk";
import { artifactRow, versionRow } from "./store.ts";

/** The sha256 stand-in for a viewer-visible push source that has no data yet. */
export const NO_DATA = "none";

export interface ShareExpect {
  version: number;
  htmlSha256: string;
  title: string;
  /** every push source that link viewers see (approved, "show to people with a link" on): key and sha256 of its live data */
  data: { key: string; sha256: string }[];
  /** sha256 over the whole source list: key, kind, label, binding digest, approved, shown to link viewers */
  sourcesSha256: string;
}

/** Push sources that link viewers see, with the live data they would get. */
export function visiblePushData(db: Db, artifactId: string): { key: string; label: string; sha256: string; bytes: number }[] {
  return db
    .prepare(
      `SELECT s.key, s.label, n.data_json FROM la_source s LEFT JOIN la_snapshot n ON n.artifact_id = s.artifact_id AND n.key = s.key
        WHERE s.artifact_id = ? AND s.kind = 'push' AND s.viewers = 1 AND s.approved_digest = s.digest ORDER BY s.key`,
    )
    .all(artifactId)
    .map((r) => {
      const text = r.data_json === null || r.data_json === undefined ? null : String(r.data_json);
      return { key: String(r.key), label: String(r.label || r.key), sha256: text === null ? NO_DATA : digest(JSON.parse(text) as Json), bytes: text === null ? 0 : Buffer.byteLength(text, "utf8") };
    });
}

/** Fingerprint of the source list as the owner reads it in the hold (labels, kinds, which ones link viewers see). */
export function sourcesSha256(db: Db, artifactId: string): string {
  const rows = db.prepare("SELECT key, kind, label, digest, approved_digest, viewers FROM la_source WHERE artifact_id = ? ORDER BY key").all(artifactId);
  return digest(
    rows.map((r) => ({
      key: String(r.key),
      kind: String(r.kind),
      label: String(r.label),
      binding: String(r.digest),
      approved: r.approved_digest !== null && r.approved_digest === r.digest,
      shown: Number(r.viewers) === 1,
    })) as Json,
  );
}

/** The expect of a link that shows version `n` of the page now (what artifact_get answers as `shareExpect`), or null. */
export function shareExpectOf(db: Db, artifactId: string, n: number): ShareExpect | null {
  const a = artifactRow(db, artifactId);
  const v = versionRow(db, artifactId, n);
  if (!a || !v) return null;
  return {
    version: n,
    htmlSha256: String(v.html_sha256),
    title: String(a.title),
    data: visiblePushData(db, artifactId).map((d) => ({ key: d.key, sha256: d.sha256 })),
    sourcesSha256: sourcesSha256(db, artifactId),
  };
}

/** What differs between the page now and what the agent asked for; [] when it is exactly that. `pin` null = the live version. */
export function shareMismatch(db: Db, artifactId: string, pin: number | null | undefined, e: ShareExpect): string[] {
  const a = artifactRow(db, artifactId);
  if (!a) return ["page"];
  const shown = pin ?? Number(a.live_version);
  const now = shareExpectOf(db, artifactId, shown);
  if (!now) return ["version"];
  const out: string[] = [];
  if (e.version !== now.version) out.push("version");
  if (e.htmlSha256 !== now.htmlSha256) out.push("page code");
  if (e.title !== now.title) out.push("title");
  if (e.sourcesSha256 !== now.sourcesSha256) out.push("data sources");
  if (JSON.stringify(e.data.map((d) => [d.key, d.sha256])) !== JSON.stringify(now.data.map((d) => [d.key, d.sha256]))) out.push("pushed data");
  return out;
}

// ── hold flags: a hold rendered on a mismatch is never approvable

const FLAG_KEEP_MS = 7 * 86_400_000;
export function flagHold(db: Db, inputDigest: string, now: number): void {
  db.prepare("DELETE FROM la_hold_flag WHERE at < ?").run(now - FLAG_KEEP_MS);
  db.prepare("INSERT OR IGNORE INTO la_hold_flag (input_digest, at) VALUES (?, ?)").run(inputDigest, now);
}
export function holdFlagged(db: Db, inputDigest: string): boolean {
  return db.prepare("SELECT 1 FROM la_hold_flag WHERE input_digest = ?").get(inputDigest) !== undefined;
}
