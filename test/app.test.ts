// Smoke test: the app boots on the SDK (manifest, handler set and migrations accepted), serves the derived routes,
// and its handlers work against the migrated table. Agent calls through a bridge are covered by `pnpm conformance`.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { manifestDigest, validateManifest } from "@opt2-tealbrick/manifest";
import { type Db, defineApp, type OpContext, startApp } from "@opt2-tealbrick/miniapp-sdk";
import { MANIFEST_DIGEST, OP } from "#kit";
import { definition, handlers, manifest } from "../src/app.ts";
import { COLLECTION, createItem, listItems } from "../src/items.ts";

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
    const refused = await fetch(`${base}/tb/v1/ops/items_list`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: {} }) });
    assert.equal(refused.status, 503);
  } finally {
    await running.stop();
  }

  const { db, close } = openDb(join(dir, "app.db"));
  t.after(close);
  const caller = { type: "agent", id: "agt_01J0000000000000000000000A", name: "Agent A", mode: "free" };
  const ctx = (readable: string[]) => ({ db, caller, scope: { readable: async () => readable } }) as unknown as OpContext;

  assert.equal(handlers.item_create.scope?.({ title: "x" }, caller as OpContext["caller"]), caller.id, "default target is the own collection");
  assert.equal(handlers.items_list.scope?.({}, caller as OpContext["caller"]), null, "no collection = across readable ones");

  const created = (await handlers.item_create.run({ title: "first" }, ctx([]))) as { id: string; collection: string };
  assert.equal(created.collection, caller.id);
  assert.match(created.id, /^itm_/);
  createItem(db, { collection: "shared", title: "second", createdBy: caller.id }, Date.now() + 1000);

  const mine = (await handlers.items_list.run({}, ctx([caller.id]))) as { items: { title: string }[] };
  assert.deepEqual(
    mine.items.map((i) => i.title),
    ["first"],
  );
  const both = (await handlers.items_list.run({ limit: 1 }, ctx([caller.id, "shared"]))) as { items: { title: string }[] };
  assert.deepEqual(
    both.items.map((i) => i.title),
    ["second"],
    "newest first, limited",
  );
  assert.deepEqual(listItems(db, [], 10), [], "no readable collection = no items");
  assert.equal(COLLECTION, manifest.scopes?.[0]?.type);
});
