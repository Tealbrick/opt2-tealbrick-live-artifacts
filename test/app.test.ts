// Smoke test: the app boots on the SDK (manifest, handler set and migrations accepted), serves the derived routes,
// and the migrated tables exist. Agent calls through a bridge are covered by `pnpm conformance`.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { manifestDigest, validateManifest } from "@opt2-tealbrick/manifest";
import { type Db, defineApp, startApp } from "@opt2-tealbrick/miniapp-sdk";
import { MANIFEST_DIGEST, OP } from "#kit";
import { definition, handlers, manifest } from "../src/app.ts";
import { GALLERY } from "../src/store.ts";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => resolve(typeof a === "object" && a ? a.port : 0));
    });
  });
}

/** node:sqlite handle shaped like the SDK's Db (the SDK gives handlers the same interface). */
function openDb(file: string): { db: Db; close(): void } {
  const raw = new DatabaseSync(file);
  const db = { exec: (sql: string) => raw.exec(sql), prepare: (sql: string) => raw.prepare(sql), transaction: <T>(fn: () => T) => fn() };
  return { db: db as unknown as Db, close: () => raw.close() };
}

test("manifest validates", () => {
  const v = validateManifest(manifest);
  assert.equal(v.ok, true, v.ok ? "" : JSON.stringify(v.errors));
});

test("the generated kit matches the manifest and every operation has exactly one handler", () => {
  assert.equal(MANIFEST_DIGEST, manifestDigest(manifest), "kit is stale: run node --run kit");
  const ids = manifest.operations.map((o) => o.id).sort();
  assert.deepEqual(Object.values(OP).sort(), ids);
  assert.deepEqual(Object.keys(handlers).sort(), ids);
});

test("boots on the SDK, serves derived routes, handlers work on the migrated table", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), `${manifest.id}-test-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const port = await freePort();
  const local = { ...manifest, runtime: { ...manifest.runtime, port } };
  const running = await startApp(defineApp({ ...definition, manifest: local }), { TB_DATA_DIR: dir, TB_STANDALONE: "1", TB_LOG_LEVEL: "error" });
  try {
    const base = `http://127.0.0.1:${port}`;
    const health = (await (await fetch(`${base}/tb/v1/health`)).json()) as { status: string; manifestDigest: string };
    assert.equal(health.status, "ok");
    assert.equal(health.manifestDigest, manifestDigest(local));
    const served = await (await fetch(`${base}/tb/v1/manifest`)).json();
    assert.equal(manifestDigest(served), manifestDigest(local));
    const openapi = (await (await fetch(`${base}/tb/v1/openapi.json`)).json()) as { paths: Record<string, unknown> };
    for (const op of manifest.operations) assert.ok(Object.keys(openapi.paths).some((p) => p.endsWith(`/${op.id}`)), `openapi lists ${op.id}`);
    // agent operations need a bridge (call proof + grant); app-alone mode refuses them
    const refused = await fetch(`${base}/tb/v1/ops/artifact_list`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: {} }) });
    assert.equal(refused.status, 503);
  } finally {
    await running.stop();
  }

  // the migrated database the SDK made holds our tables
  const { db, close } = openDb(join(dir, "app.db"));
  t.after(close);
  for (const table of ["la_artifact", "la_version", "la_source", "la_snapshot", "la_link", "la_view_day", "la_setting", "la_activity"])
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), `table ${table}`);
  assert.equal(GALLERY, manifest.scopes?.[0]?.type);
});
