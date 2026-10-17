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
import { AGENT_A, CRUD, ctxFor, type Instance, memorySecrets, migratedDb, OWNER } from "./helpers.ts";

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
    signal: new AbortController().signal,
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
  await definition.onStart?.({ db, secrets: memorySecrets(), scopes: { instances: ctxFor(db, OWNER, {}, instances).scopes.instances } } as never);
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
    const o = await refreshArtifact(db, callApp, id, { mode: "scheduled", slot: "s1", now: () => now });
    assert.equal(calls.length, 1);
    assert.deepEqual({ ...calls[0], key: undefined }, { product: "kanban", op: "issues_list", input: { status: "blocked" }, key: undefined });
    assert.deepEqual(
      o.results.map((r) => [r.key, r.status]),
      [
        ["mem", "not_approved"],
        ["tasks", "ok"],
      ],
    );
    assert.deepEqual(JSON.parse(String(snap(id, "tasks")?.data_json)), [{ title: "Fix login" }], "projection applied: no 'secret' field kept");
    assert.equal(snap(id, "mem"), undefined, "an unapproved source is never read");
    assert.equal(idemKey(["a", "b"]), idemKey(["a", "b"]));
    assert.notEqual(idemKey(["a", "b"]), idemKey(["a", "c"]));
  });
  it("held / error / paused keep the last good data and record the state (fires on bad)", async () => {
    const id = await page();
    approve(id, "tasks");
    await refreshArtifact(db, callApp, id, { mode: "scheduled", slot: "s1", now: () => now });
    const good = snap(id, "tasks")?.data_json;
    answer = async () => ({ status: "held", holdId: "hld_1", expiresAt: "x" });
    let o = await refreshArtifact(db, callApp, id, { mode: "scheduled", slot: "s2", now: () => now });
    assert.deepEqual([snap(id, "tasks")?.data_json, snap(id, "tasks")?.status, snap(id, "tasks")?.code, o.failed], [good, "held", "hld_1", false]);
    answer = async () => Promise.reject(new TbError("scope_denied", "no", 403));
    o = await refreshArtifact(db, callApp, id, { mode: "scheduled", slot: "s3", now: () => now });
    assert.deepEqual([snap(id, "tasks")?.data_json, snap(id, "tasks")?.status, snap(id, "tasks")?.code, o.failed], [good, "error", "scope_denied", true]);
    answer = async () => Promise.reject(new TbError("paused", "kill switch", 503));
    o = await refreshArtifact(db, callApp, id, { mode: "scheduled", slot: "s4", now: () => now });
    assert.deepEqual([snap(id, "tasks")?.status, o.failed, o.paused], ["paused", false, true]);
    answer = async () => ({ status: "ok", output: { other: 1 } });
    o = await refreshArtifact(db, callApp, id, { mode: "scheduled", slot: "s5", now: () => now });
    assert.deepEqual([snap(id, "tasks")?.code, o.failed], ["projection_empty", true]);
  });
  it("refuses data over 256 KiB from a source and stops at the hourly call budget", async () => {
    const id = await page();
    approve(id, "tasks");
    answer = async () => ({ status: "ok", output: { issues: [{ title: "x".repeat(LIMITS.snapshotBytes) }] } });
    await refreshArtifact(db, callApp, id, { mode: "scheduled", slot: "s1", now: () => now });
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
    assert.deepEqual(jobsLog.slice(1), [`enqueue ${REFRESH_JOB} {"id":"${id}"}`, `cancel ${jobId}`], "the new job first, then the old one is cancelled");
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
    for (let n = 0; n < LIMITS.refreshFailures; n++) {
      now = Math.max(now, Number(artifactRow(db, id)?.next_refresh_at ?? now));
      outs.push(await refreshTick({ id }, jobCtx(jobId) as never));
    }
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
    for (let n = 0; n < 7; n++) {
      now = Math.max(now, Number(artifactRow(db, id)?.next_refresh_at ?? now));
      await refreshTick({ id }, jobCtx(jobId) as never);
    }
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

describe("review of PR #3: regressions", () => {
  /** an answer that waits until `release()` so a test can change the page while the read is in flight */
  function gatedAnswer() {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    answer = async () => {
      await gate;
      return { status: "ok", output: ISSUES };
    };
    return () => release();
  }
  it("finding 1 (S1): a read in flight never lands in a key that flipped to push (agents cannot read it back)", async () => {
    const id = await page();
    approve(id, "tasks");
    const release = gatedAnswer();
    const inFlight = run("artifact_refresh", { id }, A());
    await new Promise((r) => setImmediate(r));
    await run("artifact_update", { id, contract: { v: 1, inputs: [{ key: "tasks", kind: "push" }] } }, A()); // the flip
    release();
    const out = await inFlight;
    assert.deepEqual(
      out.results.find((r: Out) => r.key === "tasks"),
      { key: "tasks", status: "not_approved", fetchedAt: null, code: "binding_changed" },
    );
    const got = await run("artifact_get", { id, include: ["data", "shape"] }, A());
    assert.deepEqual(got.data, {}, "nothing the read returned is visible to the agent");
    assert.deepEqual(got.shape, {});
  });
  it("finding 2: a revoke during the read wins (no snapshot appears afterwards)", async () => {
    const id = await page();
    approve(id, "tasks");
    const release = gatedAnswer();
    const inFlight = refreshArtifact(db, callApp, id, { mode: "scheduled", slot: "s1", now: () => now });
    await new Promise((r) => setImmediate(r));
    await run("source_revoke", { id, key: "tasks" }, O());
    release();
    await inFlight;
    assert.equal(snap(id, "tasks"), undefined);
  });
  it("finding 2 + re-review 1: an aborted tick stops reading and records nothing (no success, no failure)", async () => {
    const id = await page();
    approve(id, "tasks");
    approve(id, "mem");
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(refreshArtifact(db, callApp, id, { mode: "scheduled", slot: "s1", now: () => now, signal: ac.signal }));
    assert.deepEqual(calls, []);
    await run("trigger_approve", { id, everySeconds: 900 }, O());
    db.prepare("UPDATE la_artifact SET consecutive_failures = 3 WHERE id = ?").run(id);
    const before = artifactRow(db, id);
    const ctx = { ...jobCtx(String(before?.refresh_job_id)), signal: ac.signal };
    await assert.rejects(refreshTick({ id }, ctx as never));
    const after = artifactRow(db, id);
    assert.deepEqual([Number(after?.consecutive_failures), after?.next_refresh_at], [3, before?.next_refresh_at]);
  });
  it("re-review 2: restartRefresh enqueues before it cancels (a failed enqueue keeps the old job)", async () => {
    const id = await page();
    approve(id, "tasks");
    await run("trigger_approve", { id, everySeconds: 900 }, O());
    const oldJob = artifactRow(db, id)?.refresh_job_id;
    const saved = fakeJobs.enqueue;
    fakeJobs.enqueue = () => {
      throw new Error("enqueue failed");
    };
    try {
      jobsLog.length = 0;
      await assert.rejects(run("trigger_approve", { id, everySeconds: 3600 }, O()));
      assert.deepEqual(jobsLog, [], "the old job was not cancelled");
      assert.equal(artifactRow(db, id)?.refresh_job_id, oldJob);
    } finally {
      fakeJobs.enqueue = saved;
    }
  });
  it("re-review 3: a failing read of a source revoked meanwhile is not counted as a failure", async () => {
    const id = await page();
    approve(id, "tasks");
    await run("trigger_approve", { id, everySeconds: 900 }, O());
    answer = async () => {
      await run("source_revoke", { id, key: "tasks" }, O());
      throw new TbError("upstream_down", "x", 502);
    };
    await refreshTick({ id }, jobCtx(String(artifactRow(db, id)?.refresh_job_id)) as never);
    assert.equal(Number(artifactRow(db, id)?.consecutive_failures), 0);
  });
  it("re-review 5: repeated rate limits back off and raise attention after 5 deferrals", async () => {
    const id = await page();
    approve(id, "tasks");
    answer = async () => Promise.reject(new TbError("rate_limited", "slow down", 429));
    await run("trigger_approve", { id, everySeconds: 3600 }, O());
    const jobId = String(artifactRow(db, id)?.refresh_job_id);
    const gaps: number[] = [];
    for (let n = 0; n < 5; n++) {
      now = Math.max(now, Number(artifactRow(db, id)?.next_refresh_at ?? now));
      const r = await refreshTick({ id }, jobCtx(jobId) as never);
      gaps.push("afterMs" in r ? r.afterMs : -1);
    }
    assert.deepEqual(gaps, [60_000, 120_000, 240_000, 480_000, 960_000]);
    assert.equal(((await definition.attention?.(db)) as { code: string } | null)?.code, "refresh_rate_limited");
  });
  it("finding 3: parallel artifact_refresh calls — exactly one runs", async () => {
    const id = await page();
    approve(id, "tasks");
    const outs = await Promise.allSettled([run("artifact_refresh", { id }, A()), run("artifact_refresh", { id }, A()), run("artifact_refresh", { id }, A())]);
    assert.deepEqual(outs.map((o) => o.status).sort(), ["fulfilled", "rejected", "rejected"]);
    assert.equal(calls.length, 1);
  });
  it("finding 4: agent refreshes have their own budget; budget exhaustion is never a failure", async () => {
    const id = await page();
    approve(id, "tasks");
    const { budgets } = await import("../src/refresh.ts");
    const saved = budgets.manual;
    budgets.manual = new CallBudget(0);
    try {
      const out = await run("artifact_refresh", { id }, A());
      assert.deepEqual(out.results.find((r: Out) => r.key === "tasks"), { key: "tasks", status: "error", fetchedAt: null, code: "refresh_budget" });
    } finally {
      budgets.manual = saved;
    }
    const r = await run("trigger_approve", { id, everySeconds: 900 }, O());
    assert.equal(r.refresh.state, "on");
    await refreshTick({ id }, jobCtx(String(artifactRow(db, id)?.refresh_job_id)) as never);
    assert.equal(snap(id, "tasks")?.status, "ok", "the schedule still reads after the agent budget is gone");
  });
  it("finding 5 + 13: a retry after a failure uses a new key; a held read keeps ONE key until decided", async () => {
    const id = await page();
    approve(id, "tasks");
    answer = async () => Promise.reject(new TbError("upstream_down", "x", 502));
    await run("trigger_approve", { id, everySeconds: 3600 }, O());
    const jobId = String(artifactRow(db, id)?.refresh_job_id);
    await refreshTick({ id }, jobCtx(jobId) as never);
    now = Number(artifactRow(db, id)?.next_refresh_at);
    await refreshTick({ id }, jobCtx(jobId) as never);
    assert.notEqual(calls[0]?.key, calls[1]?.key, "same slot, but a retry after a failure is a new key");
    answer = async () => ({ status: "held", holdId: "hld_1", expiresAt: "x" });
    calls = [];
    for (let n = 0; n < 3; n++) {
      now = Number(artifactRow(db, id)?.next_refresh_at ?? now) + 3_600_000;
      await refreshTick({ id }, jobCtx(jobId) as never);
    }
    assert.equal(new Set(calls.map((c) => c.key)).size, 1, "one hold per read, not one per tick");
  });
  it("finding 6: trigger_approve on an archived page refuses BEFORE touching the job; archive stops and restore resumes", async () => {
    const id = await page();
    approve(id, "tasks");
    await run("trigger_approve", { id, everySeconds: 900 }, O());
    await run("artifact_archive", { id, archived: true }, O());
    assert.equal(artifactRow(db, id)?.refresh_job_id, null, "archive cancels the job");
    const before = jobsLog.length;
    await rejects(run("trigger_approve", { id, everySeconds: 900 }, O()), "artifact_archived");
    assert.equal(jobsLog.length, before, "no cancel, no enqueue");
    await run("artifact_archive", { id, archived: false }, O());
    assert.ok(artifactRow(db, id)?.refresh_job_id, "restore re-enqueues the approved schedule");
  });
  it("finding 7: a tick never overwrites a schedule that changed under it", async () => {
    const id = await page();
    approve(id, "tasks");
    await run("trigger_approve", { id, everySeconds: 900 }, O());
    const jobId = String(artifactRow(db, id)?.refresh_job_id);
    const release = gatedAnswer();
    const tick = refreshTick({ id }, jobCtx(jobId) as never);
    await new Promise((r) => setImmediate(r));
    await run("artifact_update", { id, contract: { v: 1, inputs: [{ key: "tasks", kind: "read", product: "kanban", op: "issues_list", input: { status: "blocked" }, projection: { path: "/issues", pick: ["title"], limit: 1 } }], triggers: [{ kind: "schedule", everySeconds: 300 }] } }, A());
    release();
    assert.deepEqual(await tick, { status: "done" });
    assert.equal(artifactRow(db, id)?.refresh_state, "waiting_approval", "the agent's new proposal waits for the owner");
  });
  it("finding 8: the owner's lowered interval survives an agent update that keeps the same proposal", async () => {
    const id = await page(); // proposes 900 s
    await run("trigger_approve", { id, everySeconds: 3600 }, O()); // owner: hourly
    await run("artifact_update", { id, view: { html: "<p>v2</p>" }, contract: (await run("artifact_get", { id }, A())).version.contract }, A());
    const r = artifactRow(db, id);
    assert.deepEqual([Number(r?.refresh_every_s), Number(r?.refresh_approved), r?.refresh_state], [3600, 1, "on"]);
  });
  it("finding 9: one paused source does not hide another source's failure", async () => {
    const id = await page();
    approve(id, "tasks");
    approve(id, "mem");
    answer = async (c) => Promise.reject(new TbError(c.product === "kanban" ? "paused" : "upstream_down", "x", 503));
    await run("trigger_approve", { id, everySeconds: 900 }, O());
    await refreshTick({ id }, jobCtx(String(artifactRow(db, id)?.refresh_job_id)) as never);
    assert.equal(Number(artifactRow(db, id)?.consecutive_failures), 1);
  });
  it("finding 10: a tick that is not due yet does not read", async () => {
    const id = await page();
    approve(id, "tasks");
    await run("trigger_approve", { id, everySeconds: 900 }, O());
    const jobId = String(artifactRow(db, id)?.refresh_job_id);
    await refreshTick({ id }, jobCtx(jobId) as never);
    const r = await refreshTick({ id }, jobCtx(jobId) as never);
    assert.equal(calls.length, 1);
    assert.deepEqual(r, { status: "again", afterMs: 900_000 });
  });
  it("finding 12: a pointer never walks the prototype", () => {
    assert.equal(pointer({ a: 1 }, "/constructor"), undefined);
    assert.equal(project({ a: 1 }, { path: "/__proto__" }), undefined);
  });
  it("finding 13: rate_limited is deferred, not a failure; source_approve refuses archived pages", async () => {
    const id = await page();
    approve(id, "tasks");
    answer = async () => Promise.reject(new TbError("rate_limited", "slow down", 429));
    await run("trigger_approve", { id, everySeconds: 900 }, O());
    await refreshTick({ id }, jobCtx(String(artifactRow(db, id)?.refresh_job_id)) as never);
    assert.equal(Number(artifactRow(db, id)?.consecutive_failures), 0);
    await run("artifact_archive", { id, archived: true }, O());
    const d = (await run("artifact_detail", { id }, O())).sources[0];
    await rejects(run("source_approve", { id, key: d.key, digest: d.digest, viewers: false }, O()), "artifact_archived");
  });
});
