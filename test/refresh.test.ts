// Sources and refresh (DESIGN §4.4, §4.6, §5.7): projection, approved-only reads through the companion grant, held and
// failing sources keep their last data, the failure counter and paused_error, the owner-enqueued job, the owner ops, and
// the C88 rule for artifact_refresh (status only, never data).
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Db, Json, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";
import { bindScopeDb, definition, handlers, refreshTick, setClock } from "../src/app.ts";
import { LIMITS } from "../src/limits.ts";
import { backoffMs, CallBudget, idemKey, pointer, project, REFRESH_JOB, refreshArtifact } from "../src/refresh.ts";
import { artifactRow } from "../src/store.ts";
import { AGENT_A, CRUD, ctxFor, type Instance, migratedDb, OWNER } from "./helpers.ts";

type Out = Record<string, any>;
type Call = { product: string; op: string; input: Json; key?: string };
let db: Db;
let instances: Instance[];
let now: number;
let calls: Call[];
let answer: (c: Call) => Promise<unknown>;
const callApp = (async (product: string, op: string, input: Json, opts?: { idempotencyKey?: string }) => {
  const c = { product, op, input, ...(opts?.idempotencyKey ? { key: opts.idempotencyKey } : {}) };
  calls.push(c);
  return answer(c);
}) as never;
const jobsLog: string[] = [];
const fakeJobs = {
  enqueue: (kind: string, input: Json) => {
    jobsLog.push(`enqueue ${kind} ${JSON.stringify(input)}`);
    return { id: `job_${jobsLog.length}`, kind, status: "queued" };
  },
  get: (id: string) => ({ id, status: "queued" }),
  cancel: (id: string) => {
    jobsLog.push(`cancel ${id}`);
    return { id, status: "cancelled" };
  },
};
const withExtras = <T extends OpContext>(ctx: T): T => Object.assign(ctx, { callApp, jobs: fakeJobs, ownerLinkFor: (p: string, path: string) => `https://portal.example/open?product=${p}&path=${path}` });
const A = () => withExtras(ctxFor(db, AGENT_A, { [AGENT_A.id]: CRUD.manage }, instances));
const O = () => withExtras(ctxFor(db, OWNER, {}, instances));
const run = async (opId: keyof typeof handlers, input: unknown, ctx: OpContext): Promise<Out> => (await handlers[opId].run(input as never, ctx)) as Out;
const rejects = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: { code?: string }) => {
    assert.equal(e.code, code);
    return true;
  });
const ISSUES = { issues: [{ id: "i1", title: "Fix login", status: "blocked", secret: "x" }, { id: "i2", title: "Ship", status: "blocked", secret: "y" }] };

async function page(): Promise<string> {
  const out = await run(
    "artifact_create",
    {
      title: "Blocked work",
      view: { html: "<p>x</p>" },
      contract: {
        v: 1,
        inputs: [
          { key: "tasks", kind: "read", product: "kanban", op: "issues_list", input: { status: "blocked" }, projection: { path: "/issues", pick: ["title"], limit: 1 } },
          { key: "mem", kind: "read", product: "knowledge", op: "recall", input: { query: "q" } },
        ],
        triggers: [{ kind: "schedule", everySeconds: 900 }],
      },
    },
    A(),
  );
  return String(out.id);
}
const approve = (id: string, key: string) => db.prepare("UPDATE la_source SET approved_digest = digest WHERE artifact_id = ? AND key = ?").run(id, key);
const snap = (id: string, key: string) => db.prepare("SELECT data_json, status, code FROM la_snapshot WHERE artifact_id = ? AND key = ?").get(id, key);
/** a JobContext the SDK would give the refresh job */
function jobCtx(jobId: string) {
  let committed = 0;
  return {
    db,
    callApp,
    job: { id: jobId },
    checkpoint: (_state: Json, write?: (d: Db) => unknown) =>
      db.transaction(() => {
        committed++;
        return write?.(db);
      }),
    statusChanged: () => {},
    get committed() {
      return committed;
    },
  };
}

beforeEach(async () => {
  db = migratedDb();
  instances = [];
  calls = [];
  jobsLog.length = 0;
  now = Date.UTC(2026, 9, 17, 12, 0, 0);
  setClock(() => now);
  answer = async () => ({ status: "ok", output: ISSUES });
  bindScopeDb(db);
  await definition.onStart?.({ db, scopes: { instances: ctxFor(db, OWNER, {}, instances).scopes.instances } } as never);
});

describe("projection (declarative only)", () => {
  it("pointer, pick on objects and array items, limit", () => {
    assert.deepEqual(pointer({ a: { "b/c": [1, 2] } }, "/a/b~1c/1"), 2);
    assert.equal(pointer({ a: 1 }, "/b"), undefined);
    assert.equal(pointer([1], "/x"), undefined);
    assert.deepEqual(project(ISSUES, { path: "/issues", pick: ["title"], limit: 1 }), [{ title: "Fix login" }]);
    assert.deepEqual(project({ a: 1, b: 2 }, { pick: ["b", "zz"] }), { b: 2 });
    assert.equal(project(ISSUES, { path: "/nope" }), undefined);
  });
});

describe("refreshArtifact", () => {
  it("reads only approved sources, through the companion grant, with a slot-stable idempotency key", async () => {
    const id = await page();
    approve(id, "tasks");
    const o = await refreshArtifact(db, callApp, id, { slot: "s1", now: () => now });
    assert.deepEqual(calls, [{ product: "kanban", op: "issues_list", input: { status: "blocked" }, key: idemKey(id, "tasks", "s1") }]);
    assert.deepEqual(
      o.results.map((r) => [r.key, r.status]),
      [
        ["mem", "not_approved"],
        ["tasks", "ok"],
      ],
    );
    assert.deepEqual(JSON.parse(String(snap(id, "tasks")?.data_json)), [{ title: "Fix login" }], "projection applied: no 'secret' field kept");
    assert.equal(snap(id, "mem"), undefined, "an unapproved source is never read");
    assert.equal(idemKey(id, "tasks", "s1"), idemKey(id, "tasks", "s1"));
    assert.notEqual(idemKey(id, "tasks", "s1"), idemKey(id, "tasks", "s2"));
  });
  it("held / error / paused keep the last good data and record the state (fires on bad)", async () => {
    const id = await page();
    approve(id, "tasks");
    await refreshArtifact(db, callApp, id, { slot: "s1", now: () => now });
    const good = snap(id, "tasks")?.data_json;
    answer = async () => ({ status: "held", holdId: "hld_1", expiresAt: "x" });
    let o = await refreshArtifact(db, callApp, id, { slot: "s2", now: () => now });
    assert.deepEqual([snap(id, "tasks")?.data_json, snap(id, "tasks")?.status, snap(id, "tasks")?.code, o.failed], [good, "held", "hld_1", false]);
    answer = async () => Promise.reject(new TbError("scope_denied", "no", 403));
    o = await refreshArtifact(db, callApp, id, { slot: "s3", now: () => now });
    assert.deepEqual([snap(id, "tasks")?.data_json, snap(id, "tasks")?.status, snap(id, "tasks")?.code, o.failed], [good, "error", "scope_denied", true]);
    answer = async () => Promise.reject(new TbError("paused", "kill switch", 503));
    o = await refreshArtifact(db, callApp, id, { slot: "s4", now: () => now });
    assert.deepEqual([snap(id, "tasks")?.status, o.failed, o.paused], ["paused", false, true]);
    answer = async () => ({ status: "ok", output: { other: 1 } });
    o = await refreshArtifact(db, callApp, id, { slot: "s5", now: () => now });
    assert.deepEqual([snap(id, "tasks")?.code, o.failed], ["projection_empty", true]);
  });
  it("refuses data over 256 KiB from a source and stops at the hourly call budget", async () => {
    const id = await page();
    approve(id, "tasks");
    answer = async () => ({ status: "ok", output: { issues: [{ title: "x".repeat(LIMITS.snapshotBytes) }] } });
    await refreshArtifact(db, callApp, id, { slot: "s1", now: () => now });
    assert.equal(snap(id, "tasks")?.code, "data_too_large");
    const b = new CallBudget(2);
    assert.deepEqual([b.take(0), b.take(1), b.take(2), b.take(3_600_001)], [true, true, false, true]);
  });
});

describe("the refresh job", () => {
  async function scheduled(): Promise<{ id: string; jobId: string }> {
    const id = await page();
    approve(id, "tasks");
    const r = await run("trigger_approve", { id, everySeconds: 900 }, O());
    assert.equal(r.refresh.state, "on");
    return { id, jobId: String(artifactRow(db, id)?.refresh_job_id) };
  }
  it("trigger_approve (owner) enqueues ONE job; changing it cancels the old one; null switches off", async () => {
    const { id, jobId } = await scheduled();
    assert.deepEqual(jobsLog, [`enqueue ${REFRESH_JOB} {"id":"${id}"}`]);
    await run("trigger_approve", { id, everySeconds: 3600 }, O());
    assert.deepEqual(jobsLog.slice(1), [`cancel ${jobId}`, `enqueue ${REFRESH_JOB} {"id":"${id}"}`]);
    const off = await run("trigger_approve", { id, everySeconds: null }, O());
    assert.equal(off.refresh.state, "off");
    assert.equal(artifactRow(db, id)?.refresh_job_id, null);
  });
  it("a tick refreshes in one checkpoint and runs again after the interval", async () => {
    const { id, jobId } = await scheduled();
    const ctx = jobCtx(jobId);
    const r = await refreshTick({ id }, ctx as never);
    assert.deepEqual(r, { status: "again", afterMs: 900_000 });
    assert.equal(ctx.committed, 1, "snapshots + refresh columns in ONE checkpoint");
    assert.equal(snap(id, "tasks")?.status, "ok");
    assert.equal(Number(artifactRow(db, id)?.last_refresh_at), now);
  });
  it("5 failed ticks in a row → paused_error, the job ends, attention fires; the owner resumes", async () => {
    const { id, jobId } = await scheduled();
    answer = async () => Promise.reject(new TbError("upstream_down", "x", 502));
    const outs = [];
    for (let n = 0; n < LIMITS.refreshFailures; n++) outs.push(await refreshTick({ id }, jobCtx(jobId) as never));
    assert.deepEqual(
      outs.map((o) => ("afterMs" in o ? o.afterMs : o.status)),
      [60_000, 120_000, 240_000, 480_000, "done"],
    );
    assert.equal(artifactRow(db, id)?.refresh_state, "paused_error");
    assert.deepEqual(await definition.attention?.(db), { code: "refresh_stopped", reason: "1 live page(s) stopped refreshing after repeated failures" });
    answer = async () => ({ status: "ok", output: ISSUES });
    await run("trigger_approve", { id, everySeconds: 900 }, O());
    assert.deepEqual([artifactRow(db, id)?.refresh_state, Number(artifactRow(db, id)?.consecutive_failures)], ["on", 0]);
    assert.equal(await definition.attention?.(db), null, "quiet again on good");
    assert.equal(backoffMs(300, 9), 300_000, "backoff never longer than the interval");
  });
  it("a kill switch does not count as a failure", async () => {
    const { id, jobId } = await scheduled();
    answer = async () => Promise.reject(new TbError("paused", "kill switch", 503));
    for (let n = 0; n < 7; n++) await refreshTick({ id }, jobCtx(jobId) as never);
    assert.deepEqual([artifactRow(db, id)?.refresh_state, Number(artifactRow(db, id)?.consecutive_failures)], ["paused", 0]);
  });
  it("an old job, an archived or deleted page, or a switched-off schedule ends the tick without a read", async () => {
    const { id, jobId } = await scheduled();
    assert.deepEqual(await refreshTick({ id }, jobCtx("job_other") as never), { status: "done" });
    db.prepare("UPDATE la_artifact SET status = 'archived' WHERE id = ?").run(id);
    assert.deepEqual(await refreshTick({ id }, jobCtx(jobId) as never), { status: "done" });
    assert.deepEqual(await refreshTick({ id: "art_x" }, jobCtx(jobId) as never), { status: "done" });
    assert.deepEqual(calls, []);
  });
  it("attention: an approved schedule more than 10 minutes overdue is reported (lost or failed job)", async () => {
    const { id } = await scheduled();
    db.prepare("UPDATE la_artifact SET next_refresh_at = ? WHERE id = ?").run(now - 11 * 60_000, id);
    const att = (await definition.attention?.(db)) as { code: string } | null;
    assert.equal(att?.code, "refresh_overdue");
  });
});

describe("agent artifact_refresh and owner source ops", () => {
  it("artifact_refresh returns the status per source, never data (C88), once a minute per page", async () => {
    const id = await page();
    approve(id, "tasks");
    const out = await run("artifact_refresh", { id }, A());
    assert.deepEqual(
      out.results.map((r: Out) => [r.key, r.status]),
      [
        ["mem", "not_approved"],
        ["tasks", "ok"],
      ],
    );
    assert.ok(!JSON.stringify(out).includes("Fix login"), "no read value in the agent answer");
    await rejects(run("artifact_refresh", { id }, A()), "refresh_rate_limited");
    now += LIMITS.manualRefreshMs;
    await run("artifact_refresh", { id, keys: ["tasks"] }, A());
  });
  it("source_approve binds the exact digest (digest_changed on a changed binding); revoke deletes the data", async () => {
    const id = await page();
    const detail = await run("artifact_detail", { id }, O());
    const tasks = detail.sources.find((s: Out) => s.key === "tasks");
    assert.deepEqual(await run("source_approve", { id, key: "tasks", digest: tasks.digest, viewers: true }, O()), { key: "tasks", approved: true, viewers: true });
    await run("artifact_update", { id, contract: { v: 1, inputs: [{ key: "tasks", kind: "read", product: "kanban", op: "issues_list", input: { status: "done" } }] } }, A());
    await rejects(run("source_approve", { id, key: "tasks", digest: tasks.digest, viewers: true }, O()), "digest_changed");
    const fresh = (await run("artifact_detail", { id }, O())).sources[0];
    await run("source_approve", { id, key: "tasks", digest: fresh.digest, viewers: false }, O());
    await run("artifact_refresh", { id }, A());
    assert.ok(snap(id, "tasks"));
    assert.deepEqual(await run("source_revoke", { id, key: "tasks" }, O()), { key: "tasks", approved: false });
    assert.equal(snap(id, "tasks"), undefined);
    await rejects(run("source_revoke", { id, key: "nope" }, O()), "source_unknown");
  });
  it("source_test shows the owner a sample; scope_denied links to the source app's Configure page", async () => {
    const id = await page();
    const ok = await run("source_test", { id, key: "tasks" }, O());
    assert.deepEqual([ok.status, ok.sample, ok.rows], ["ok", [{ title: "Fix login" }], 1]);
    answer = async () => Promise.reject(new TbError("scope_denied", "no", 403));
    const denied = await run("source_test", { id, key: "mem" }, O());
    assert.deepEqual([denied.status, denied.code, denied.configureLink], ["error", "scope_denied", "https://portal.example/open?product=knowledge&path=/configure"]);
  });
});
