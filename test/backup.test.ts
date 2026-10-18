// S6 backup and restore on the REAL SDK: `tb.export` and the cron backup are the SDK's archive of app.db; this test proves
// that a round trip carries everything the app keeps: pages, versions, pushed data, source approvals, links (fingerprints
// only), view counts, hold flags and the pending hold itself, and that a restored link still opens.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { DOC_KEY_SECRET, ensureDocKey, RESTORE_EPOCH_FILE } from "../src/viewer.ts";
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
/** wait until the app recorded that it handled the restore (la_setting restore_handled) */
async function handled(dir: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const db = new DatabaseSync(join(dir, "app.db"), { readOnly: true });
    try {
      if (db.prepare("SELECT 1 FROM la_setting WHERE key = 'restore_handled'").get()) return;
    } finally {
      db.close();
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the restore was not handled in 5 s");
}
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
  let shareInput: Record<string, any> = {};
  let holdBefore: { status: string; view: string | null; summary: string } = { status: "", view: null, summary: "" };
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
    shareInput = { id, expect: stale, label: "Stranger" };
    const held = await a.call("artifact_share", shareInput, { held: ["public_link"], key: "idem-bk-share", agent: a.w.agent2 });
    assert.equal(held.status, 202, JSON.stringify(held.body));
    holdId = String(held.body.holdId);
    await a.approve(holdId);
    // the owner approved a hold that said "Do not approve": the backup holds an APPROVED flagged hold
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
    holdBefore = a.hold(holdId);
    const run = await a.running.backups.runNow();
    archive = basename(run.file);
    const exp = await a.running.backups.exportNow();
    exportFile = basename(exp.file);
    for await (const _chunk of exp.stream as unknown as AsyncIterable<unknown>) void _chunk; // drain
    // AFTER the backup the owner revokes the link: a restore from this backup would bring it back to life
    assert.equal((await owner.op("link_revoke", { linkId })).status, 200);
    assert.equal((await a.viewer(`/v/live-artifacts/${token}`, { "sec-fetch-dest": "document" })).status, 404, "revoked in A");
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

  it("the document-ticket key (secret doc_ticket_key) is not in the export, and its plaintext is in neither archive", async () => {
    const key = await ensureDocKey({ get: async () => null, put: async () => {} }); // the key app A uses (cached in this process)
    assert.ok(key.length >= 32);
    for (const [name, file] of [["export", exportFile], ["backup", archive]] as const) {
      const out = join(root, `extract-key-${name}`);
      mkdirSync(out);
      execFileSync("tar", ["-xzf", join(backupDir, file), "-C", out]);
      for (const f of readdirSync(out, { recursive: true }).map(String)) {
        let bytes: Buffer;
        try {
          bytes = readFileSync(join(out, f));
        } catch {
          continue;
        }
        assert.ok(!bytes.includes(Buffer.from(key)), `the plaintext ticket key is in ${name}/${f}`);
        if (name === "export") assert.ok(!bytes.includes(Buffer.from(DOC_KEY_SECRET)), `the secret's name is in the export file ${f}`);
      }
    }
  });

  it("the archive holds the link as a fingerprint and no plaintext token (the SDK keeps the answer of a link call, with the address, SEALED under TB_KEK for 24 hours; that sealed copy is in the archive)", () => {
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

  it("restoring into a fresh deployment brings back every la_ table row for row, except that every link is ended (a link revoked after the backup stays dead)", async () => {
    b = await boot(VIEWS, { dir: dirB, keepDir: true, world: a.w, env: { TB_BACKUP_DIR: backupDir, TB_KEK: KEK, TB_RESTORE_FROM: archive } });
    await handled(dirB); // onStart ends the links shortly after the app is up
    const after = dump(join(dirB, "app.db"));
    assert.deepEqual(Object.keys(after).sort(), Object.keys(beforeDump).sort());
    const noRevoked = (rows: string[] | undefined): string[] => (rows ?? []).map((r) => JSON.stringify({ ...(JSON.parse(r) as object), revoked_at: null })).sort();
    for (const t of Object.keys(beforeDump)) {
      if (t === "la_link") assert.deepEqual(noRevoked(after[t]), noRevoked(beforeDump[t]), "the links are the same rows, apart from revoked_at");
      else if (t === "la_setting") assert.deepEqual((after[t] ?? []).filter((r) => !/restore_(pending|handled)/.test(r)), beforeDump[t], "settings are kept; the two restore markers are new");
      else if (t === "la_activity") for (const r of beforeDump[t] ?? []) assert.ok(after[t]?.includes(r), "every activity row is kept");
      else assert.deepEqual(after[t], beforeDump[t], `table ${t} differs after restore`);
    }
    assert.ok((after.la_setting ?? []).some((r) => /restore_handled/.test(r)), "the app recorded that it handled the restore");
    for (const r of after.la_link ?? []) assert.notEqual((JSON.parse(r) as { revoked_at: unknown }).revoked_at, null, "every link is ended after a restore");
    assert.ok((after.la_activity ?? []).some((r) => /ended because the data was restored/.test(r)), "the page's activity says why");
    for (const t of ["la_artifact", "la_version", "la_snapshot", "la_source", "la_link", "la_view_day", "la_hold_flag"]) assert.ok((beforeDump[t] ?? []).length > 0, `${t} had rows to carry`);
    // the link was revoked AFTER the backup: in the restored database it looked active; it must stay dead
    assert.equal((await b.viewer(`/v/live-artifacts/${token}`, { "sec-fetch-dest": "document" })).status, 404, "the link revoked after the backup does not come back");
    assert.equal((await b.viewer(`/v/live-artifacts/${token}/data`)).status, 404);
    // the page, its versions and its data came back; the owner makes a new link
    const owner = await b.person();
    const fresh = await owner.op("link_create", { id: String((JSON.parse(after.la_artifact?.[0] ?? "{}") as { id: string }).id), label: "After restore" }, { key: "idem-bk-after-restore" });
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
    const newToken = String((fresh.body.output as { url: string }).url.split("/").pop());
    const data = (await (await b.viewer(`/v/live-artifacts/${newToken}/data`)).json()) as { sources: Record<string, { data?: unknown }>; title: string };
    assert.deepEqual(data.sources.n?.data, { total: 42 }, "pushed data came back");
    assert.equal(data.title, "Renamed");
    // the hold that said "Do not approve" and was approved is still flagged: the call never runs
    const retry = await b.call("artifact_share", shareInput, { held: ["public_link"], key: "idem-bk-share", agent: b.w.agent2 });
    assert.equal(retry.status, 409, JSON.stringify(retry.body));
    assert.equal(retry.body.error.code, "page_changed");
    assert.equal(b.links().filter((l) => l.label === "Stranger").length, 0, "the stranger's link was never made");
    const hold = b.hold(holdId);
    assert.equal(holdBefore.status, "approved", "in the backup the flagged hold was approved");
    assert.ok(["approved", "failed"].includes(hold.status), `the hold came back (${hold.status}); it never ran: no link below`);
  });

  it("a crash after the restore and before the app wrote its handled marker: on the next start every viewer link still ends", async () => {
    assert.ok(b, "restored deployment B exists");
    await b?.stop();
    b = undefined;
    // the state after a crash between afterRestore and the app's handling: the SDK's marker is there, the app's is not, and the
    // restored links are alive again as in the backup
    const db = new DatabaseSync(join(dirB, "app.db"));
    try {
      assert.ok(db.prepare("SELECT value FROM la_setting WHERE key = 'restore_pending'").get(), "the afterRestore hook wrote the pending marker");
      db.exec("DELETE FROM la_setting WHERE key = 'restore_handled'");
      db.exec("UPDATE la_link SET revoked_at = NULL WHERE kind = 'viewer'");
      assert.ok(Number(db.prepare("SELECT COUNT(*) AS c FROM la_link WHERE revoked_at IS NULL").get()?.c) > 0, "links are alive in the crashed state");
    } finally {
      db.close();
    }
    const c = await boot(VIEWS, { dir: dirB, keepDir: true, world: a.w, env: { TB_BACKUP_DIR: backupDir, TB_KEK: KEK } });
    try {
      assert.equal((await c.viewer(`/v/live-artifacts/${token}`, { "sec-fetch-dest": "document" })).status, 404, "the link stays dead");
      const check = new DatabaseSync(join(dirB, "app.db"), { readOnly: true });
      try {
        assert.equal(Number(check.prepare("SELECT COUNT(*) AS c FROM la_link WHERE kind = 'viewer' AND revoked_at IS NULL").get()?.c), 0, "every viewer link ended");
        assert.ok(check.prepare("SELECT value FROM la_setting WHERE key = 'restore_handled'").get(), "and the app recorded that");
      } finally {
        check.close();
      }
    } finally {
      await c.stop();
    }
  });

  // S8: the SDK writes its own restore marker (tb_meta.restore_applied) into the restored app.db BEFORE it calls afterRestore. A
  // hard kill between the two leaves no restore_pending, and the next boot skips the archive as already applied, so the hook
  // never runs. The app compares the SDK marker with its epoch file outside app.db.
  const killedState = (newSdkMarker: boolean): void => {
    const db = new DatabaseSync(join(dirB, "app.db"));
    try {
      db.exec("DELETE FROM la_setting WHERE key IN ('restore_pending', 'restore_handled')");
      db.exec("UPDATE la_link SET revoked_at = NULL WHERE kind = 'viewer'");
      if (newSdkMarker) db.prepare("UPDATE tb_meta SET value = ? WHERE key = 'restore_applied'").run(JSON.stringify(`killed-${randomBytes(4).toString("hex")}`));
    } finally {
      db.close();
    }
  };
  const aliveLinks = (): number => {
    const db = new DatabaseSync(join(dirB, "app.db"), { readOnly: true });
    try {
      return Number(db.prepare("SELECT COUNT(*) AS c FROM la_link WHERE kind = 'viewer' AND revoked_at IS NULL").get()?.c);
    } finally {
      db.close();
    }
  };
  it("the epoch file outside app.db holds the SDK marker the app handled", () => {
    const db = new DatabaseSync(join(dirB, "app.db"), { readOnly: true });
    try {
      assert.equal(readFileSync(join(dirB, RESTORE_EPOCH_FILE), "utf8"), String(db.prepare("SELECT value FROM tb_meta WHERE key = 'restore_applied'").get()?.value));
    } finally {
      db.close();
    }
  });
  it("quiet on good: the same state with the SDK marker already handled (no new restore) leaves the links alone", async () => {
    killedState(false);
    const d = await boot(VIEWS, { dir: dirB, keepDir: true, world: a.w, env: { TB_BACKUP_DIR: backupDir, TB_KEK: KEK } });
    try {
      await new Promise((r) => setTimeout(r, 300)); // onStart has run
      assert.ok(aliveLinks() > 0, "no restore to handle: links stay as they are");
    } finally {
      await d.stop();
    }
  });
  it("a hard kill after the SDK wrote its marker and before afterRestore: no link opens, and onStart ends them", async () => {
    killedState(true);
    assert.ok(aliveLinks() > 0, "links are alive in the killed state");
    const d = await boot(VIEWS, { dir: dirB, keepDir: true, world: a.w, env: { TB_BACKUP_DIR: backupDir, TB_KEK: KEK } });
    try {
      assert.equal((await d.viewer(`/v/live-artifacts/${token}`, { "sec-fetch-dest": "document" })).status, 404, "the link stays dead");
      const db = new DatabaseSync(join(dirB, "app.db"), { readOnly: true });
      let marker: string;
      try {
        marker = String(db.prepare("SELECT value FROM tb_meta WHERE key = 'restore_applied'").get()?.value);
      } finally {
        db.close();
      }
      for (let i = 0; i < 100 && readFileSync(join(dirB, RESTORE_EPOCH_FILE), "utf8") !== marker; i++) await new Promise((r) => setTimeout(r, 50));
      assert.equal(readFileSync(join(dirB, RESTORE_EPOCH_FILE), "utf8"), marker, "the app recorded the new marker in the epoch file");
      assert.equal(aliveLinks(), 0, "every viewer link ended");
    } finally {
      await d.stop();
    }
  });
});
