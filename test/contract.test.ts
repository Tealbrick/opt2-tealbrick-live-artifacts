// The artifact contract (DESIGN §3.0): quiet on good contracts, fires with the exact code on bad ones (L27, L34).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { manifest } from "../src/app.ts";
import { companionOps, contractJson, normalizeContract, parseStoredContract, type RawContract, sourceDigest } from "../src/contract.ts";
import { LIMITS } from "../src/limits.ts";

const C = companionOps(manifest);
const code = (fn: () => unknown, expected: string) =>
  assert.throws(fn, (e: { code?: string }) => {
    assert.equal(e.code, expected);
    return true;
  });

describe("companions", () => {
  it("only read-only manifest companions feed pages, exactly the declared ops", () => {
    assert.deepEqual([...C.keys()].sort(), ["kanban", "knowledge"]);
    for (const c of manifest.companions ?? []) {
      assert.deepEqual(c.crud, ["read"], `${c.product} companion is read-only (a write here would let a page refresh change data)`);
      assert.deepEqual([...(C.get(c.product) ?? [])].sort(), [...c.operations].sort());
    }
  });
  it("a write companion is ignored (fires on bad)", () => {
    const m = companionOps({ companions: [{ product: "kanban", operations: ["issue_create"], crud: ["create"] }] });
    assert.equal(m.size, 0);
  });
});

describe("normalizeContract", () => {
  it("accepts push + read sources and one schedule; normalises and round-trips", () => {
    const raw: RawContract = {
      v: 1,
      inputs: [
        { key: "numbers", kind: "push", label: " Weekly numbers " },
        { key: "tasks", kind: "read", product: "kanban", op: "issues_list", input: { status: "blocked" }, projection: { path: "/issues", pick: ["title", "title", "status"], limit: 20 } },
      ],
      triggers: [{ kind: "schedule", everySeconds: 900 }],
    };
    const c = normalizeContract(raw, C);
    assert.equal(c.inputs.length, 2);
    assert.deepEqual(c.inputs[0], { key: "numbers", kind: "push", label: "Weekly numbers" });
    assert.deepEqual(c.inputs[1], { key: "tasks", kind: "read", label: "", product: "kanban", op: "issues_list", input: { status: "blocked" }, projection: { path: "/issues", pick: ["title", "status"], limit: 20 } });
    assert.deepEqual(c.schedule, { everySeconds: 900 });
    assert.deepEqual(parseStoredContract(JSON.stringify(contractJson(c))), c);
  });
  it("no contract = empty contract", () => {
    assert.deepEqual(normalizeContract(undefined, C), { v: 1, inputs: [], schedule: null });
  });
  it("refuses later-stage fields with unsupported_in_this_version, never ignores them (L3)", () => {
    code(() => normalizeContract({ v: 1, output: { schema: {} } }, C), "unsupported_in_this_version");
    code(() => normalizeContract({ v: 1, program: { runtime: "qjs-wasm/1" } }, C), "unsupported_in_this_version");
    code(() => normalizeContract({ v: 1, inputs: [{ key: "e", kind: "event" }] }, C), "unsupported_in_this_version");
    code(() => normalizeContract({ v: 1, triggers: [{ kind: "event" }] }, C), "unsupported_in_this_version");
    for (const f of ["where", "sort", "count"])
      code(() => normalizeContract({ v: 1, inputs: [{ key: "t", kind: "read", product: "kanban", op: "issues_list", projection: { [f]: 1 } }] }, C), "unsupported_in_this_version");
  });
  it("refuses a read of an op that is not a read-only companion op (source_not_allowed)", () => {
    code(() => normalizeContract({ v: 1, inputs: [{ key: "t", kind: "read", product: "kanban", op: "issue_create" }] }, C), "source_not_allowed");
    code(() => normalizeContract({ v: 1, inputs: [{ key: "t", kind: "read", product: "connect", op: "tools" }] }, C), "source_not_allowed");
    code(() => normalizeContract({ v: 1, inputs: [{ key: "t", kind: "read", product: "kanban" }] }, C), "source_invalid");
  });
  it("refuses shape errors JSON Schema cannot see", () => {
    code(() => normalizeContract({ v: 1, inputs: [{ key: "a", kind: "push" }, { key: "a", kind: "push" }] }, C), "source_key_duplicate");
    code(() => normalizeContract({ v: 1, inputs: [{ key: "a", kind: "push", product: "kanban" }] }, C), "source_invalid");
    code(() => normalizeContract({ v: 1, triggers: [{ kind: "schedule", everySeconds: 600 }, { kind: "schedule", everySeconds: 900 }] }, C), "trigger_duplicate");
    code(() => normalizeContract({ v: 1, triggers: [{ kind: "schedule" }] }, C), "trigger_invalid");
    code(() => normalizeContract({ v: 1, inputs: [{ key: "t", kind: "read", product: "kanban", op: "issues_list", projection: { path: "issues" } }] }, C), "projection_invalid");
    code(() => normalizeContract({ v: 2 }, C), "contract_version");
    const big = { q: "x".repeat(LIMITS.sourceInputBytes) };
    code(() => normalizeContract({ v: 1, inputs: [{ key: "t", kind: "read", product: "kanban", op: "issues_list", input: big }] }, C), "source_input_too_large");
    const many = Array.from({ length: LIMITS.sources + 1 }, (_, n) => ({ key: `k${n}`, kind: "push" }));
    code(() => normalizeContract({ v: 1, inputs: many }, C), "too_many_sources");
  });
});

describe("sourceDigest (binding approval)", () => {
  const read = (input: Record<string, never> | { status: string }, limit = 10) =>
    normalizeContract({ v: 1, inputs: [{ key: "t", kind: "read", product: "kanban", op: "issues_list", input, projection: { limit } }] }, C).inputs[0];
  it("is stable for the same binding (key order does not matter: JCS)", () => {
    const a = normalizeContract({ v: 1, inputs: [{ key: "t", kind: "read", product: "kanban", op: "issues_list", input: { a: 1, b: 2 } }] }, C).inputs[0];
    const b = normalizeContract({ v: 1, inputs: [{ key: "t", kind: "read", product: "kanban", op: "issues_list", input: { b: 2, a: 1 } }] }, C).inputs[0];
    assert.ok(a && b);
    assert.equal(sourceDigest(a), sourceDigest(b));
  });
  it("changes when the input or the projection changes (fires: approval must clear)", () => {
    const x = read({ status: "blocked" });
    const y = read({ status: "done" });
    const z = read({ status: "blocked" }, 11);
    assert.ok(x && y && z);
    assert.notEqual(sourceDigest(x), sourceDigest(y));
    assert.notEqual(sourceDigest(x), sourceDigest(z));
  });
});
