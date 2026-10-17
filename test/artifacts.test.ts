// Handlers against the migrated database: galleries and access, versions and the live pointer, staging on shared pages,
// pushed data, limits, copies and the C88 rule. Each guard has a quiet-on-good and a fire-on-bad case (L27, L34).
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Db, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { bindScopeDb, definition, handlers, setClock } from "../src/app.ts";
import { LIMITS } from "../src/limits.ts";
import { artifactRow, GALLERY, pruneVersions, SHARED_GALLERY } from "../src/store.ts";
import { AGENT_A, AGENT_B, CRUD, ctxFor, type Instance, migratedDb, OWNER } from "./helpers.ts";

type Out = Record<string, any>;
const run = async (opId: keyof typeof handlers, input: unknown, ctx: OpContext): Promise<Out> => (await handlers[opId].run(input as never, ctx)) as Out;
const rejects = async (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: { code?: string }) => {
    assert.equal(e.code, code);
    return true;
  });

const PAGE = "<!doctype html><h1>Report</h1><script>tb.ready()</script>";
const page = (n: number) => `<!doctype html><h1>Report ${n}</h1>`;

let db: Db;
let instances: Instance[];
let now: number;
const A = () => ctxFor(db, AGENT_A, { [AGENT_A.id]: CRUD.manage, [SHARED_GALLERY]: CRUD.contribute }, instances);
const B = (access: Record<string, readonly ("read" | "create" | "update" | "delete")[]> = { [AGENT_B.id]: CRUD.manage }) => ctxFor(db, AGENT_B, access, instances);
const O = () => ctxFor(db, OWNER, {}, instances);
/** an active viewer link (S4 creates these through a held op; here a row is enough to test staging) */
function addLink(id: string, pin: number | null = null): void {
  db.prepare(
    "INSERT INTO la_link (id, artifact_id, kind, token_digest, label, created_by_type, created_by_id, created_by_name, created_at, expires_at, pin_version) VALUES (?, ?, 'viewer', ?, '', 'person', 'per_x', 'Owner', ?, ?, ?)",
  ).run(`lnk_${Math.random().toString(36).slice(2)}`, id, `sha256:${Math.random()}`, now, now + 86_400_000, pin);
}
async function create(ctx: OpContext, extra: Record<string, unknown> = {}): Promise<Out> {
  return run("artifact_create", { title: "Blocked work", view: { html: PAGE }, ...extra }, ctx);
}

beforeEach(async () => {
  db = migratedDb();
  instances = [];
  now = Date.UTC(2026, 9, 17, 12, 0, 0);
  setClock(() => now);
  bindScopeDb(db);
  await definition.onStart?.({ db, scopes: { instances: ctxFor(db, OWNER, {}, instances).scopes.instances } } as never);
});

describe("galleries and access", () => {
  it("onStart makes the shared gallery; an agent's first call makes its own; galleries_list shows access levels", async () => {
    assert.deepEqual(instances, [{ type: GALLERY, id: SHARED_GALLERY, label: "Shared", shared: true }]);
    const out = await run("galleries_list", {}, A());
    assert.deepEqual(
      out.galleries.map((g: Out) => [g.id, g.access, g.shared]),
      [
        [SHARED_GALLERY, "contribute", true],
        [AGENT_A.id, "manage", false],
      ],
    );
  });
  it("creates in the caller's own gallery by default and returns a review link for the owner", async () => {
    const out = await create(A(), { contract: { v: 1, inputs: [{ key: "tasks", kind: "read", product: "kanban", op: "issues_list" }], triggers: [{ kind: "schedule", everySeconds: 900 }] } });
    assert.match(out.id, /^art_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(out.gallery, AGENT_A.id);
    assert.equal(out.version, 1);
    assert.deepEqual(out.review, { sourcesPending: 1, triggerPending: true, ownerLink: `https://portal.example/w/ws/open?product=live-artifacts&path=${encodeURIComponent(`/page/${out.id}`)}` });
    assert.deepEqual(out.lint, []);
  });
  it("an agent without access gets not_found, the same answer as a missing id (no existence oracle)", async () => {
    const { id } = await create(A());
    const missing = "art_01J00000000000000000000000";
    await rejects(run("artifact_get", { id }, B()), "not_found");
    await rejects(run("artifact_get", { id: missing }, B()), "not_found");
    await rejects(run("artifact_update", { id, title: "x" }, B()), "not_found");
    await rejects(run("artifact_data_put", { id, key: "k", data: 1 }, B()), "not_found");
    assert.deepEqual((await run("artifact_list", {}, B())).items, []);
  });
  it("read access lets an agent read but not change (scope_denied); create needs create on the gallery", async () => {
    const { id } = await create(A());
    const reader = B({ [AGENT_A.id]: CRUD.read });
    assert.equal((await run("artifact_get", { id }, reader)).artifact.id, id);
    await rejects(run("artifact_update", { id, title: "x" }, reader), "scope_denied");
    await rejects(run("artifact_create", { gallery: AGENT_A.id, title: "x", view: { html: PAGE } }, reader), "scope_denied");
    await rejects(run("artifact_create", { gallery: "nope", title: "x", view: { html: PAGE } }, A()), "gallery_not_found");
  });
});

describe("versions and the live pointer", () => {
  it("new HTML = new version, live at once on an unshared page; title-only edits make no version", async () => {
    const { id } = await create(A());
    const u = await run("artifact_update", { id, view: { html: page(2) }, note: "v2" }, A());
    assert.deepEqual([u.version, u.liveVersion, u.staged], [2, 2, false]);
    const t = await run("artifact_update", { id, title: "Renamed" }, A());
    assert.deepEqual([t.version, t.liveVersion], [2, 2]);
    const same = await run("artifact_update", { id, view: { html: page(2) } }, A());
    assert.equal(same.version, 2, "the same HTML makes no new version");
    const got = await run("artifact_get", { id, include: ["versions"] }, A());
    assert.equal(got.artifact.title, "Renamed");
    assert.equal(got.version.html, page(2));
    assert.deepEqual(
      got.versions.map((v: Out) => [v.n, v.live]),
      [
        [2, true],
        [1, false],
      ],
    );
  });
  it("expectedVersion refuses a stale update (version_conflict) and passes a current one", async () => {
    const { id } = await create(A());
    await run("artifact_update", { id, expectedVersion: 1, view: { html: page(2) } }, A());
    await rejects(run("artifact_update", { id, expectedVersion: 1, view: { html: page(3) } }, A()), "version_conflict");
  });
  it("a changed binding needs approval again; an unchanged one keeps it", async () => {
    const contract = (status: string) => ({ v: 1, inputs: [{ key: "tasks", kind: "read", product: "kanban", op: "issues_list", input: { status } }] });
    const { id } = await create(A(), { contract: contract("blocked") });
    db.prepare("UPDATE la_source SET approved_digest = digest, viewers = 1 WHERE artifact_id = ?").run(id); // the owner approved (S3 op)
    const same = await run("artifact_update", { id, contract: contract("blocked"), view: { html: page(2) } }, A());
    assert.equal(same.review.sourcesPending, 0, "unchanged binding stays approved after a version change");
    const changed = await run("artifact_update", { id, contract: contract("done") }, A());
    assert.equal(changed.review.sourcesPending, 1, "changed input → pending");
    const s = (await run("artifact_get", { id, include: ["sources"] }, A())).sources[0];
    assert.deepEqual([s.approved, s.viewers, s.status], [false, false, "not_approved"]);
  });
  it("keeps the newest 20 versions plus the live one and link-pinned ones", async () => {
    const { id } = await create(A());
    addLink(id, 1); // a link pins version 1
    db.prepare("UPDATE la_artifact SET auto_publish = 'agent' WHERE id = ?").run(id);
    for (let n = 2; n <= 26; n++) await run("artifact_update", { id, view: { html: page(n) } }, A());
    const ns = () => db.prepare("SELECT n FROM la_version WHERE artifact_id = ? ORDER BY n").all(id).map((r) => Number(r.n));
    const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, k) => k + a);
    assert.deepEqual(ns(), [1, ...range(7, 26)], "newest 20 + the pinned version 1");
    await run("publish_version", { id, version: 7 }, O()); // owner rolls back to 7
    await run("autopublish_set", { id, mode: "owner" }, O()); // agent changes now wait (the page has a link)
    for (let n = 27; n <= 29; n++) assert.equal((await run("artifact_update", { id, view: { html: page(n) } }, A())).staged, true);
    assert.deepEqual(ns(), [1, 7, ...range(10, 29)], "live 7 and pinned 1 survive; staged 29 is among the newest");
    assert.equal(pruneVersions(db, id), 0, "prune is idempotent");
    assert.equal(LIMITS.versionsKept, 20);
  });
});

describe("staging on shared pages (C109 rule applied to public content)", () => {
  it("with an active link and autoPublish owner, a new version and pushed data wait; the owner publishes them", async () => {
    const { id } = await create(A(), { contract: { v: 1, inputs: [{ key: "n", kind: "push" }] } });
    await run("artifact_data_put", { id, key: "n", data: { total: 1 } }, A());
    addLink(id);
    const u = await run("artifact_update", { id, view: { html: page(2) } }, A());
    assert.deepEqual([u.version, u.liveVersion, u.staged], [2, 1, true]);
    const p = await run("artifact_data_put", { id, key: "n", data: { total: 2 } }, A());
    assert.equal(p.staged, true);
    assert.deepEqual((await run("artifact_get", { id, include: ["data"] }, A())).data, { n: { total: 1 } }, "viewers still see the published data");
    const pub = await run("publish_version", { id, version: 2 }, O());
    assert.deepEqual(pub, { liveVersion: 2, publishedKeys: ["n"] });
    const got = await run("artifact_get", { id, include: ["data"] }, A());
    assert.deepEqual([got.artifact.liveVersion, got.artifact.stagedVersion, got.data.n.total], [2, null, 2]);
  });
  it("autoPublish agent (owner opt-in) puts changes live at once even with a link", async () => {
    const { id } = await create(A());
    addLink(id);
    await run("autopublish_set", { id, mode: "agent" }, O());
    const u = await run("artifact_update", { id, view: { html: page(2) } }, A());
    assert.deepEqual([u.liveVersion, u.staged], [2, false]);
  });
  it("the owner can roll back to an older version; a missing version is refused", async () => {
    const { id } = await create(A());
    await run("artifact_update", { id, view: { html: page(2) } }, A());
    assert.equal((await run("publish_version", { id, version: 1 }, O())).liveVersion, 1);
    await rejects(run("publish_version", { id, version: 9 }, O()), "version_unknown");
  });
});

describe("pushed data and limits", () => {
  it("only a push source takes data; unknown keys and read sources are refused", async () => {
    const { id } = await create(A(), { contract: { v: 1, inputs: [{ key: "n", kind: "push" }, { key: "t", kind: "read", product: "kanban", op: "issues_list" }] } });
    const ok = await run("artifact_data_put", { id, key: "n", data: [1, 2, 3] }, A());
    assert.deepEqual([ok.key, ok.staged, ok.bytes], ["n", false, 7]);
    await rejects(run("artifact_data_put", { id, key: "t", data: 1 }, A()), "source_not_push");
    await rejects(run("artifact_data_put", { id, key: "x", data: 1 }, A()), "source_unknown");
  });
  it("refuses data over 256 KiB per source and 1 MiB per page", async () => {
    const keys = ["a", "b", "c", "d", "e"];
    const { id } = await create(A(), { contract: { v: 1, inputs: keys.map((key) => ({ key, kind: "push" })) } });
    await rejects(run("artifact_data_put", { id, key: "a", data: "x".repeat(LIMITS.snapshotBytes) }, A()), "data_too_large");
    const chunk = "x".repeat(LIMITS.snapshotBytes - 1000);
    for (const k of keys.slice(0, 4)) await run("artifact_data_put", { id, key: k, data: chunk }, A());
    await rejects(run("artifact_data_put", { id, key: "e", data: chunk }, A()), "data_too_large");
    await run("artifact_data_put", { id, key: "a", data: chunk }, A()); // replacing a key does not count twice
  });
  it("refuses HTML over 256 KiB and HTML that loads outside files", async () => {
    await rejects(create(A(), { view: { html: `<p>${"é".repeat(LIMITS.htmlBytes / 2)}</p>` } }), "html_too_large");
    await rejects(create(A(), { view: { html: '<script src="https://cdn.example/x.js"></script>' } }), "view_lint_failed");
    await rejects(create(A(), { view: { html: PAGE, site: {} } }), "unsupported_in_this_version");
    await rejects(run("artifact_create", { title: "x" }, A()), "view_missing");
    const advice = await create(A(), { view: { html: '<script>fetch("/x")</script>' } });
    assert.deepEqual(
      advice.lint.map((l: Out) => l.code),
      ["network_api"],
    );
  });
  it("refuses a 26th page in one gallery (limit_reached)", async () => {
    for (let n = 0; n < LIMITS.artifactsPerGallery; n++) await create(A());
    await rejects(create(A()), "limit_reached");
    await create(A(), { gallery: SHARED_GALLERY }); // another gallery still has room
  });
});

describe("C88: agents never get values read from another app", () => {
  it("include data returns pushed data only; shape has keys and counts, no values", async () => {
    const { id } = await create(A(), { contract: { v: 1, inputs: [{ key: "n", kind: "push" }, { key: "t", kind: "read", product: "kanban", op: "issues_list" }] } });
    await run("artifact_data_put", { id, key: "n", data: { total: 3 } }, A());
    // a refresh (S3) wrote the owner-approved read result
    db.prepare("INSERT INTO la_snapshot (artifact_id, key, data_json, bytes, status) VALUES (?, 't', ?, 10, 'ok')").run(id, JSON.stringify({ items: [{ title: "SECRET-TITLE-42" }] }));
    const got = await run("artifact_get", { id, include: ["data", "shape", "sources"] }, A());
    assert.deepEqual(got.data, { n: { total: 3 } });
    assert.deepEqual(got.shape.t, { type: "object", keys: { items: { type: "array", rows: 1, item: { type: "object", keys: 1 } } } });
    assert.ok(!JSON.stringify(got).includes("SECRET-TITLE-42"), "no read value in any agent answer");
  });
  it("a Rules narrowing fails closed on include data (R1) and is ignored by plain reads (R0)", async () => {
    const { id } = await create(A());
    const narrowed = ctxFor(db, AGENT_A, { [AGENT_A.id]: CRUD.manage }, instances, { "rules.narrowing": { v: 1, ruleId: "r1", reason: "x", memoryTags: { anyOf: ["a"] } } });
    await rejects(run("artifact_get", { id, include: ["data"] }, narrowed), "narrowing_unsupported");
    assert.equal((await run("artifact_get", { id }, narrowed)).artifact.id, id);
  });
});

describe("copies, deletes and owner pages", () => {
  it("fromId copies HTML and source proposals; copied read sources need approval again", async () => {
    const { id } = await create(A(), { contract: { v: 1, inputs: [{ key: "t", kind: "read", product: "kanban", op: "issues_list" }] } });
    db.prepare("UPDATE la_source SET approved_digest = digest WHERE artifact_id = ?").run(id);
    const copy = await run("artifact_create", { title: "Copy", fromId: id, gallery: SHARED_GALLERY }, A());
    assert.equal(copy.review.sourcesPending, 1);
    const got = await run("artifact_get", { id: copy.id }, A());
    assert.deepEqual([got.version.html, got.artifact.forkedFrom, got.artifact.origin.kind], [PAGE, id, "copy"]);
    await rejects(run("artifact_create", { title: "x", fromId: id }, B()), "not_found");
  });
  it("delete: the scope resolver answers not_found for a missing id (no hold) and the gallery for a real one", async () => {
    const { id } = await create(A());
    addLink(id);
    const spec = handlers.artifact_delete;
    assert.equal(spec.scope?.({ id } as never, AGENT_A as never), AGENT_A.id);
    assert.throws(() => spec.scope?.({ id: "art_01J00000000000000000000000" } as never, AGENT_A as never), (e: { code?: string }) => e.code === "not_found");
    assert.match(spec.holdView?.({ id } as never) ?? "", /Delete the live page "Blocked work"/);
    assert.deepEqual(await run("artifact_delete", { id }, A()), { deleted: true, linksRevoked: 1 });
    assert.equal(artifactRow(db, id), undefined);
    for (const t of ["la_version", "la_source", "la_link", "la_activity"]) assert.equal(Number(db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get()?.c), 0, t);
    const contributor = B({ [SHARED_GALLERY]: CRUD.contribute });
    const shared = await create(A(), { gallery: SHARED_GALLERY });
    await rejects(run("artifact_delete", { id: shared.id }, contributor), "scope_denied");
  });
  it("gallery_view counts pages that need review; artifact_new adds an owner page; archive filters", async () => {
    await create(A(), { contract: { v: 1, inputs: [{ key: "t", kind: "read", product: "kanban", op: "issues_list" }] } });
    const own = await run("artifact_new", { title: "Owner page", html: PAGE }, O());
    assert.equal(own.gallery, SHARED_GALLERY);
    let view = await run("gallery_view", {}, O());
    assert.deepEqual(view.counts, { all: 2, review: 1, shared: 0, stale: 0, archived: 0 });
    assert.equal(await definition.pendingCount?.(db), 1);
    await run("artifact_archive", { id: own.id, archived: true }, O());
    view = await run("gallery_view", { filter: "archived" }, O());
    assert.deepEqual(
      view.items.map((i: Out) => i.id),
      [own.id],
    );
    assert.equal((await run("gallery_view", {}, O())).counts.all, 1);
    const detail = await run("artifact_detail", { id: own.id }, O());
    assert.deepEqual(
      detail.activity.map((a: Out) => a.action),
      ["artifact.archive", "artifact.create"],
    );
    assert.deepEqual(await run("settings_set", { defaultLinkDays: 14 }, O()), { defaultLinkDays: 14 });
    assert.equal((await run("gallery_view", {}, O())).settings.defaultLinkDays, 14);
  });
  it("artifact_list pages with a cursor, newest first", async () => {
    const ids: string[] = [];
    for (let n = 0; n < 5; n++) {
      now += 1000;
      ids.push((await create(A())).id);
    }
    const p1 = await run("artifact_list", { limit: 2 }, A());
    const p2 = await run("artifact_list", { limit: 2, cursor: p1.nextCursor }, A());
    const p3 = await run("artifact_list", { limit: 2, cursor: p2.nextCursor }, A());
    assert.deepEqual([...p1.items, ...p2.items, ...p3.items].map((i: Out) => i.id), ids.reverse());
    assert.equal(p3.nextCursor, null);
    await rejects(run("artifact_list", { cursor: "bad" }, A()), "cursor_invalid");
  });
});
