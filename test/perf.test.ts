// S6 performance budgets. Each case takes the MEDIAN of several timed runs (after a warm-up) and prints it, so the numbers
// land in the test log. A budget is a ceiling several times the number seen on the dev Mac (PERF_BUDGET_SCALE multiplies
// all ceilings for a slow CI host); the aim is to catch a regression to quadratic behaviour, not to rank machines.
//   target: sanitizer and viewer document path on a 1 MiB page: median under 50 ms on the dev Mac.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { beforeEach, describe, it } from "node:test";
import { opaqueDigest } from "@opt2-tealbrick/manifest";
import type { Db, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { bindScopeDb, definition, handlers, setClock } from "../src/app.ts";
import { LIMITS } from "../src/limits.ts";
import { lintHtml } from "../src/lint.ts";
import { clearSanitizeCache, sanitizeHtml } from "../src/sanitize.ts";
import { handleViewer, newToken, resolveToken, VIEW_PREFIX, type ViewerConfig, viewData } from "../src/viewer.ts";
import { AGENT_A, CRUD, ctxFor, type Instance, memorySecrets, migratedDb, OWNER } from "./helpers.ts";

const SCALE = Number(process.env.PERF_BUDGET_SCALE ?? 1);
const CFG: ViewerConfig = { viewOrigin: "https://views-abc.up.railway.app", mainOrigin: "https://bridge-abc.up.railway.app", workspaceName: "Acme", docKey: "perf-doc-key-0123456789abcdef" };
const VIEWS = "https://views-abc.up.railway.app";
type Out = Record<string, any>;

/** median of `runs` timed calls after `warm` untimed ones, in ms */
function median(fn: () => void, runs = 9, warm = 2, before?: () => void): number {
  for (let i = 0; i < warm; i++) fn();
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    before?.();
    const a = performance.now();
    fn();
    t.push(performance.now() - a);
  }
  t.sort((x, y) => x - y);
  return t[Math.floor(runs / 2)] as number;
}
const report = (what: string, ms: number, budget: number): void => {
  console.log(`perf: ${what}: median ${ms.toFixed(1)} ms (ceiling ${(budget * SCALE).toFixed(0)} ms)`);
  assert.ok(ms < budget * SCALE, `${what}: median ${ms.toFixed(1)} ms is over the ${budget * SCALE} ms ceiling`);
};

/** A realistic dashboard-like page of about `bytes` bytes: styles, a table, svg-free markup, data: images, one script. */
function bigPage(bytes: number): string {
  let s = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Big</title><style>body{margin:0;font:14px sans-serif}.row{padding:4px}</style></head><body>';
  let i = 0;
  while (s.length < bytes - 200) {
    s += `<div class="row r${i}" style="color:red"><span>Item ${i}</span><a href="#x${i}" title="a &amp; b">link ${i}</a><img alt="" src="data:image/gif;base64,R0lGOD"><table><tr><td>${i}</td></tr></table></div>\n`;
    i++;
  }
  return `${s}<script>tb.onData(function(d){});tb.ready();</script></body></html>`;
}

describe("sanitizer and viewer document path on a 1 MiB page (target: under 50 ms median)", () => {
  const MIB = 1024 * 1024;
  const html = bigPage(MIB);
  it("sanitizeHtml, 1 MiB", () => {
    assert.ok(html.length >= MIB - 300 && html.length <= MIB + 300, String(html.length));
    report("sanitizeHtml 1 MiB (cold)", median(() => sanitizeHtml(html)), 150);
  });
  it("sanitizeHtml at the version size cap (256 KiB, always verified by a second parse)", () => {
    const capped = bigPage(LIMITS.htmlBytes);
    report("sanitizeHtml 256 KiB (with verification)", median(() => sanitizeHtml(capped)), 60);
  });

  let db: Db;
  beforeEach(() => {
    db = migratedDb();
  });
  function pageWith(htmlText: string, now: number): string {
    db.prepare(
      `INSERT INTO la_artifact (id, gallery_id, title, description, status, live_version, auto_publish, refresh_state, created_by_type, created_by_id, created_by_name, created_at, updated_at)
       VALUES ('art_01J00000000000000000000BIG', 'shared', 'Big', '', 'active', 1, 'owner', 'off', 'agent', 'agt_x', 'Scout', ?, ?)`,
    ).run(now, now);
    db.prepare(
      "INSERT INTO la_version (artifact_id, n, html, html_sha256, contract_json, contract_sha256, bytes, created_by_type, created_by_id, created_by_name, created_at) VALUES ('art_01J00000000000000000000BIG', 1, ?, 'x', '{}', 'x', 1, 'agent', 'agt_x', 'Scout', ?)",
    ).run(Buffer.from(htmlText, "utf8"), now);
    const token = newToken();
    db.prepare(
      "INSERT INTO la_link (id, artifact_id, kind, token_digest, label, created_by_type, created_by_id, created_by_name, created_at, expires_at) VALUES ('lnk_01J00000000000000000000BAG', 'art_01J00000000000000000000BIG', 'viewer', ?, '', 'person', 'per_x', 'Owner', ?, ?)",
    ).run(opaqueDigest(token), now, now + 86_400_000);
    return token;
  }
  it("the viewer path (/data, then the framed document) for a 1 MiB page: cold (sanitized each time) and warm (cached)", async () => {
    const now = Date.now();
    const token = pageWith(html, now);
    const req = (path: string, dest: string) => new Request(`http://live-artifacts.views.internal${path}`, { headers: { "sec-fetch-dest": dest } });
    const data = (await handleViewer(db, req(`/${token}/data`, "empty"), CFG, now).json()) as { doc: string };
    const path = `/${data.doc}`;
    assert.ok(path.startsWith("/_d/"), path);
    const get = () => {
      const r = handleViewer(db, req(path, "iframe"), CFG, now);
      assert.equal(r.status, 200);
    };
    report("viewer document path, 1 MiB, cold", median(get, 9, 1, clearSanitizeCache), 150);
    report("viewer document path, 1 MiB, warm (cache hit)", median(get), 40);
    const shell = median(() => void handleViewer(db, req(`/${token}`, "document"), CFG, now), 15);
    report("viewer shell", shell, 10);
    const dataMs = median(() => void handleViewer(db, req(`/${token}/data`, "empty"), CFG, now), 15);
    report("viewer /data", dataMs, 10);
    assert.ok(VIEW_PREFIX.length > 0);
  });
});

describe("many versions, many links, large data", () => {
  let db: Db;
  let instances: Instance[];
  let now: number;
  const agent = () => ctxFor(db, AGENT_A, { [AGENT_A.id]: CRUD.manage, shared: CRUD.manage }, instances, {}, { viewUrl: VIEWS });
  const owner = () => ctxFor(db, OWNER, {}, instances, {}, { viewUrl: VIEWS });
  const run = async (op: keyof typeof handlers, input: unknown, ctx: OpContext): Promise<Out> => (await handlers[op].run(input as never, ctx)) as Out;
  beforeEach(async () => {
    db = migratedDb();
    instances = [];
    now = Date.UTC(2026, 9, 17, 12, 0, 0);
    setClock(() => now);
    bindScopeDb(db);
    await definition.onStart?.({ db, secrets: memorySecrets(), scopes: { instances: ctxFor(db, OWNER, {}, instances).scopes.instances } } as never);
  });
  const timeAsync = async (fn: () => Promise<unknown>, runs = 7): Promise<number> => {
    await fn();
    const t: number[] = [];
    for (let i = 0; i < runs; i++) {
      const a = performance.now();
      await fn();
      t.push(performance.now() - a);
    }
    t.sort((x, y) => x - y);
    return t[Math.floor(runs / 2)] as number;
  };

  it("a page at the size cap: create, lint and many updates stay fast; versions are pruned to the limit", async () => {
    const capped = bigPage(LIMITS.htmlBytes - 1024);
    assert.ok(Buffer.byteLength(capped) <= LIMITS.htmlBytes);
    report("lintHtml at the cap", median(() => lintHtml(capped)), 80);
    const created = await run("artifact_create", { title: "Cap", view: { html: capped } }, agent());
    const id = String(created.id);
    let n = 1;
    const update = async () => {
      n++;
      now += 1000;
      await run("artifact_update", { id, view: { html: capped.replace("Big", `Big ${n}`) }, expectedVersion: n - 1 }, agent());
    };
    const ms = await timeAsync(update, 25);
    report("artifact_update of a 255 KiB page (versions piling up)", ms, 80);
    const kept = Number(db.prepare("SELECT COUNT(*) AS c FROM la_version WHERE artifact_id = ?").get(id)?.c);
    assert.ok(kept <= LIMITS.versionsKept + 2, `kept ${kept} versions, the limit is ${LIMITS.versionsKept} besides the live and staged ones`);
    const get = await timeAsync(() => run("artifact_get", { id, include: ["versions"] }, agent()));
    report("artifact_get with the version list after many updates", get, 40);
  });

  it("many links: the workspace cap (50), a long list of ended links, token lookup and the Links page stay fast", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(String((await run("artifact_create", { title: `Page ${i}`, view: { html: "<!doctype html><body>v1</body>" } }, agent())).id));
    const tokens: string[] = [];
    for (const id of ids) for (let k = 0; k < 5; k++) tokens.push(String((await run("link_create", { id, label: `L${k}` }, owner())).url).split("/").pop() as string);
    assert.equal(tokens.length, LIMITS.linksPerWorkspace);
    // thousands of ended links (revoked) of past weeks: they only pile up in the table
    const ins = db.prepare(
      "INSERT INTO la_link (id, artifact_id, kind, token_digest, label, created_by_type, created_by_id, created_by_name, created_at, expires_at, revoked_at) VALUES (?, ?, 'viewer', ?, '', 'person', 'per_x', 'Owner', ?, ?, ?)",
    );
    db.transaction(() => {
      for (let i = 0; i < 5000; i++) ins.run(`lnk_${String(i).padStart(26, "0")}`, ids[i % ids.length], opaqueDigest(`ended-${i}`), now - 1000, now + 1000, now - 500);
    });
    const resolve = median(() => {
      for (const t of tokens) assert.ok(resolveToken(db, t, now));
    }, 15);
    report("resolve 50 link tokens among 5,050 rows", resolve, 15);
    const list = await timeAsync(() => run("links_list", {}, owner()));
    report("links_list (capped list over 5,050 rows)", list, 60);
    const listed = await run("links_list", {}, owner());
    assert.ok(listed.items.length <= LIMITS.linksListMax && listed.items.length >= LIMITS.linksPerWorkspace, String(listed.items.length));
    const gallery = await timeAsync(() => run("artifact_list", {}, owner()));
    report("artifact_list (10 pages, 50 active links)", gallery, 40);
  });

  it("the data a page may hold (8 sources, 1 MiB in all) is assembled for a viewer quickly", async () => {
    const created = await run(
      "artifact_create",
      {
        title: "Data",
        view: { html: "<!doctype html><body>v1</body>" },
        contract: { v: 1, inputs: Array.from({ length: LIMITS.sources }, (_, i) => ({ key: `s${i}`, kind: "push", label: `S${i}` })) },
      },
      agent(),
    );
    const id = String(created.id);
    const chunk = Math.floor(LIMITS.artifactDataBytes / LIMITS.sources) - 64;
    db.transaction(() => {
      for (let i = 0; i < LIMITS.sources; i++) {
        const data = JSON.stringify({ rows: "x".repeat(chunk - 12) });
        db.prepare("UPDATE la_source SET approved_digest = digest, viewers = 1 WHERE artifact_id = ? AND key = ?").run(id, `s${i}`);
        db.prepare("UPDATE la_snapshot SET data_json = ?, bytes = ?, status = 'ok', fetched_at = ? WHERE artifact_id = ? AND key = ?").run(data, data.length, now, id, `s${i}`);
        db.prepare("INSERT OR IGNORE INTO la_snapshot (artifact_id, key, data_json, bytes, status, fetched_at) VALUES (?, ?, ?, ?, 'ok', ?)").run(id, `s${i}`, data, data.length, now);
      }
    });
    const token = String((await run("link_create", { id }, owner())).url).split("/").pop() as string;
    const link = resolveToken(db, token, now);
    assert.ok(link);
    report("viewData with 8 sources, 1 MiB of data", median(() => void viewData(db, link, CFG, now), 11), 60);
  });
});
