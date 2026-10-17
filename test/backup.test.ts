// S6 backup and restore on the REAL SDK: `tb.export` and the cron backup are the SDK's archive of app.db; this test proves
// that a round trip carries everything the app keeps: pages, versions, pushed data, source approvals, links (fingerprints
// only, never the address), view counts, hold flags and the pending hold itself, and that a restored link still opens.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { type Booted, boot, VIEWS } from "./e2e-helper.ts";

const tables = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'la\\_%' ESCAPE '\\' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
/** every la_* table, every row, as JSON (blobs as hex) */
function dump(dbFile: string): Record<string, string[]> {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const out: Record<string, string[]> = {};
    for (const t of tables(db)) {
      out[t] = (db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[])
        .map((r) => JSON.stringify(r, (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v)))
        .sort();
    }
    return out;
  } finally {
    db.close();
  }
}
/** the deploy recipe sets one TB_KEK for the deployment; sealed values (the document-ticket key, sealed answers) open after a restore only with the same one */
const KEK = randomBytes(32).toString("base64url");
const PAGE = { title: "Weekly operations", view: { html: "<!doctype html><html><body><h1>v1</h1></body></html>" } };

describe("backup and restore round trip (real SDK)", () => {
  const root = mkdtempSync(join(tmpdir(), "la-backup-"));
  const backupDir = join(root, "backup");
  const dirA = join(root, "a");
  const dirB = join(root, "b");
  let a: Booted;
  let b: Booted | undefined;
  let token = "";
  let linkId = "";
  let holdId = "";
  let beforeDump: Record<string, string[]>;
  let archive = "";
  let exportFile = "";
  before(async () => {
    mkdirSync(backupDir, { recursive: true });
    mkdirSync(dirA);
    mkdirSync(dirB);
    a = await boot(VIEWS, { dir: dirA, keepDir: true, env: { TB_BACKUP_DIR: backupDir, TB_KEK: KEK } });
    const created = await a.call("artifact_create", { ...PAGE, gallery: "shared", contract: { v: 1, inputs: [{ key: "n", kind: "push", label: "Numbers" }] } }, { held: [], key: "idem-bk-create" });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = String(created.body.output.id);
    const owner = await a.person();
    const sources = await a.call("artifact_get", { id, include: ["sources"] }, { held: [] });
    assert.equal((await owner.op("source_approve", { id, key: "n", digest: sources.body.output.sources[0].digest, viewers: true })).status, 200);
    assert.equal((await a.call("artifact_data_put", { id, key: "n", data: { total: 42 } }, { held: [], key: "idem-bk-put" })).status, 200);
    // an older version before the link exists, then the link (pinned to version 2 so versions matter)
    assert.equal((await a.call("artifact_update", { id, view: { html: "<!doctype html><html><body><h1>v2</h1></body></html>" }, expectedVersion: 1 }, { held: [], key: "idem-bk-update" })).status, 200);
    // another agent asks for a link with a stale page: a hold that starts "Do not approve" and a flagged input
    const stale = (await a.call("artifact_get", { id }, { held: [], agent: a.w.agent2 })).body.output.shareExpect;
    assert.equal((await a.call("artifact_update", { id, title: "Renamed" }, { held: [], key: "idem-bk-rename" })).status, 200);
    const held = await a.call("artifact_share", { id, expect: stale, label: "Stranger" }, { held: ["public_link"], key: "idem-bk-share", agent: a.w.agent2 });
    assert.equal(held.status, 202, JSON.stringify(held.body));
    holdId = String(held.body.holdId);
    const made = await owner.op("link_create", { id, label: "Board", expiresInDays: 30, pin: 2 }, { key: "idem-bk-link" });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    token = String((made.body.output as { url: string }).url.split("/").pop());
    linkId = String((made.body.output as { linkId: string }).linkId);
    // a viewer opens the page (a view count)
    assert.equal((await a.viewer(`/v/live-artifacts/${token}`, { "sec-fetch-dest": "document" })).status, 200);
    const flagged = new DatabaseSync(join(dirA, "app.db"), { readOnly: true });
    assert.equal(Number((flagged.prepare("SELECT COUNT(*) AS c FROM la_hold_flag").get() as { c: number }).c), 1, "a hold flag exists to carry over");
    flagged.close();
    beforeDump = dump(join(dirA, "app.db"));
    const run = await a.running.backups.runNow();
    archive = basename(run.file);
    const exp = await a.running.backups.exportNow();
    exportFile = basename(exp.file);
    for await (const _chunk of exp.stream as unknown as AsyncIterable<unknown>) void _chunk; // drain
    await a.stop();
  });
  after(async () => {
    // also when `before` failed half way: a running app and its bridge would keep the test process alive for ever
    await a?.stop();
    await b?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("the backup is written to the backup volume and carries the database", () => {
    assert.ok(readdirSync(backupDir).includes(archive), archive);
    const out = join(root, "extract");
    mkdirSync(out);
    execFileSync("tar", ["-xzf", join(backupDir, archive), "-C", out]);
    const files = readdirSync(out, { recursive: true }).map(String);
    assert.ok(files.some((f) => f.endsWith("app.db")), `no app.db in ${files.join(", ")}`);
  });

  it("tb.export carries the same database: pages, versions, data, links, hold flags", () => {
    assert.ok(exportFile.startsWith("tb-export-"), exportFile);
    const out = join(root, "extract-export");
    mkdirSync(out);
    execFileSync("tar", ["-xzf", join(backupDir, exportFile), "-C", out]);
    const files = readdirSync(out, { recursive: true }).map(String);
    const rows = (t: string): Record<string, unknown>[] =>
      readFileSync(join(out, "tables", `${t}.jsonl`), "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    for (const t of ["la_artifact", "la_version", "la_snapshot", "la_source", "la_link", "la_view_day", "la_hold_flag"]) assert.equal(rows(t).length, (beforeDump[t] ?? []).length, `export row count of ${t}`);
    const link = rows("la_link")[0] ?? {};
    assert.match(String(link.token_digest), /^sha256:[0-9a-f]{64}$/, "the link is a fingerprint");
    assert.deepEqual(Object.keys(link).filter((k) => /url|token$|address/i.test(k)), [], "no address column");
    for (const f of files) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(join(out, f));
      } catch {
        continue;
      }
      assert.ok(!bytes.includes(Buffer.from(token)), `the link token is in ${f} of the export`);
    }
  });

  it("the archive holds the link as a fingerprint, never the address or the token", () => {
    const out = join(root, "extract2");
    mkdirSync(out);
    execFileSync("tar", ["-xzf", join(backupDir, archive), "-C", out]);
    for (const f of readdirSync(out, { recursive: true }).map(String)) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(join(out, f));
      } catch {
        continue; // a directory
      }
      assert.ok(!bytes.includes(Buffer.from(token)), `the link token is in ${f}`);
      assert.ok(!bytes.includes(Buffer.from(token.slice(4))), `the link token body is in ${f}`);
    }
    const link = (beforeDump.la_link ?? []).map((r) => JSON.parse(r) as Record<string, unknown>).find((r) => r.id === linkId);
    assert.ok(link && /^[0-9a-f]{64}$|^sha256:|^[A-Za-z0-9_-]{20,}$/.test(String(link.token_digest)), "a digest is stored");
  });

  it("restoring into a fresh deployment brings back every la_ table row for row, and the link opens", async () => {
    b = await boot(VIEWS, { dir: dirB, keepDir: true, world: a.w, env: { TB_BACKUP_DIR: backupDir, TB_KEK: KEK, TB_RESTORE_FROM: archive } });
    const after = dump(join(dirB, "app.db"));
    assert.deepEqual(Object.keys(after).sort(), Object.keys(beforeDump).sort());
    for (const t of Object.keys(beforeDump)) assert.deepEqual(after[t], beforeDump[t], `table ${t} differs after restore`);
    for (const t of ["la_artifact", "la_version", "la_snapshot", "la_source", "la_link", "la_view_day", "la_hold_flag"]) assert.ok((beforeDump[t] ?? []).length > 0, `${t} had rows to carry`);
    // the page, its versions and the pinned link work after the restore
    assert.equal((await b.viewer(`/v/live-artifacts/${token}`, { "sec-fetch-dest": "document" })).status, 200, "the restored link opens");
    const data = (await (await b.viewer(`/v/live-artifacts/${token}/data`)).json()) as { sources: Record<string, { data?: unknown }>; title: string };
    assert.deepEqual(data.sources.n?.data, { total: 42 }, "pushed data came back");
    assert.equal(data.title, "Renamed");
    const hold = b.hold(holdId);
    assert.equal(hold.status, "held", "the pending hold came back");
    assert.equal((hold.view ?? "").split("\n")[0], "Do not approve: this is not the page as it is now.", "…with its warning");
  });
});
