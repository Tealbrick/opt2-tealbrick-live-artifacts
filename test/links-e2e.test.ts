// S4 on the REAL SDK (miniapp-sdk 0.1.26): the app runs under `startApp` behind a fake bridge that signs slices, grants and
// call proofs. Covers what unit tests with a fake context cannot: the SDK holds the call (holdId, listed hold with the
// owner's text), the approved retry runs ONCE and returns the address (L27), link_needs_hold for a grant without
// public_link, view_origin_missing from the slice, and the viewer route as the SDK serves it (prefix /v/live-artifacts,
// GET only, headers). Quiet on good and fire on bad: each case asserts the exact status and code.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { VIEWER_HEADER_FLOOR } from "@opt2-tealbrick/manifest";
import type { Json } from "@opt2-tealbrick/miniapp-sdk";
import { manifest } from "../src/app.ts";

import { type Booted, boot, VIEWS } from "./e2e-helper.ts";

const PAGE = { title: "Weekly operations", view: { html: "<!doctype html><html><body><h1>v1</h1></body></html>" } };

/** What the agent saw with artifact_get: `shareExpect`, ready to pass as `expect` (for the version a link would show). */
async function looked(b: Booted, id: string, pin?: number, agent?: `agt_${string}`): Promise<Record<string, any>> {
  const g = await b.call("artifact_get", { id, ...(pin ? { version: pin } : {}) }, { held: [], ...(agent ? { agent } : {}) });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  return g.body.output.shareExpect;
}

describe("links on the real SDK (viewer address present)", () => {
  let b: Booted;
  let pageId = "";
  before(async () => {
    b = await boot(VIEWS);
    const created = await b.call("artifact_create", PAGE, { held: [], key: "idem-key-create-1" });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    pageId = String(created.body.output.id);
  });
  after(async () => {
    await b?.stop();
  });

  it("the manifest declares the viewer route and the SDK serves it on the prefix /v/live-artifacts, GET only", async () => {
    assert.deepEqual(manifest.publicRoutes, [{ path: "/v", purpose: "viewer" }]);
    const res = await b.viewer("/v/live-artifacts/tbv_nope");
    assert.equal(res.status, 404);
    for (const [k, v] of Object.entries(VIEWER_HEADER_FLOOR)) if (k !== "content-security-policy") assert.equal(res.headers.get(k), v, `floor header ${k}`);
    assert.equal(res.headers.get("set-cookie"), null);
    const post = await b.viewer("/v/live-artifacts/tbv_nope", {}, "POST");
    assert.equal(post.status, 405, "GET only (the SDK refuses before our handler)");
    assert.equal((await b.viewer("/v/live-artifacts")).status, 404);
    assert.equal((await b.viewer("/v/other-product/x")).status, 404);
  });

  it("link_needs_hold: a grant that does not hold public_link is refused before anything is created (fail closed)", async () => {
    const e = await looked(b, pageId);
    for (const op of ["artifact_share", "artifact_publish"] as const) {
      const input: Json = op === "artifact_share" ? { id: pageId, expect: e } : { id: pageId, version: 1, expect: { htmlSha256: e.htmlSha256 }, data: [] };
      const r = await b.call(op, input, { held: [], key: `idem-key-needs-${op}` });
      assert.equal(r.status, 403, `${op}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error.code, "link_needs_hold");
    }
    assert.equal(b.links().length, 0, "no link was created");
    // a grant that holds OTHER families only is just as short
    const other = await b.call("artifact_share", { id: pageId, expect: e }, { held: ["destructive", "money"], key: "idem-key-needs-other" });
    assert.equal(other.body.error?.code, "link_needs_hold");
    // and without `expect` the SDK refuses the input before the handler (the field is required)
    const bare = await b.call("artifact_share", { id: pageId }, { held: ["public_link"], key: "idem-key-needs-expect" });
    assert.equal(bare.status, 400);
    assert.equal(bare.body.error.code, "input_invalid");
  });

  let token = "";
  it("held flow: the SDK holds artifact_share (holdId, listed, owner text); approval runs the SAME call once and returns the address (L27)", async () => {
    const input = { id: pageId, label: "Novak Dental", expiresInDays: 7, expect: await looked(b, pageId) };
    const first = await b.call("artifact_share", input, { held: ["public_link"], key: "idem-key-share-1" });
    assert.equal(first.status, 202, JSON.stringify(first.body));
    assert.equal(first.body.status, "held");
    const holdId = String(first.body.holdId);
    assert.match(holdId, /^hld_/);
    assert.equal(b.links().length, 0, "nothing is created while held");
    const h = b.hold(holdId);
    assert.equal(h.status, "held");
    assert.match(h.summary, /Weekly operations/);
    assert.match(h.view ?? "", /Create a public link to the live page "Weekly operations"/);
    assert.match(h.view ?? "", /Version 1: 1 KiB, sha256 [0-9a-f]{16}…, written by "Scout"\./);
    assert.match(h.view ?? "", /7 days after you approve/);
    assert.match(h.view ?? "", /The agent saw exactly this page/);
    assert.ok(!/tbv_/.test(h.view ?? "") && !h.summary.includes("tbv_"), "no address in the hold");

    // the agent repeating the call while it waits gets the same hold, not a second link
    const again = await b.call("artifact_share", input, { held: ["public_link"], key: "idem-key-share-1" });
    assert.equal(again.status, 202);
    assert.equal(again.body.holdId, holdId);

    await b.approve(holdId);
    const run = await b.call("artifact_share", input, { held: ["public_link"], key: "idem-key-share-1" });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    const out = run.body.output as { linkId: string; url: string; expiresAt: string };
    assert.match(out.url, new RegExp(`^${VIEWS}/v/live-artifacts/tbv_[A-Za-z0-9_-]{43}$`));
    assert.match(out.linkId, /^lnk_/);
    token = out.url.split("/").pop() ?? "";
    assert.equal(token.length, 47, "there is a token, so the absence checks below can fail");
    assert.equal(b.links().length, 1, "approved: exactly one link");
    assert.equal(b.hold(holdId).status, "run");

    // the sealed answer replays (the address stays available for the retrying agent) and creates no second link
    const replay = await b.call("artifact_share", input, { held: ["public_link"], key: "idem-key-share-1" });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.output.url, out.url);
    assert.equal(b.links().length, 1);
    // the link table holds only a digest of the address; the hold and its summary never had it
    assert.ok(!JSON.stringify(b.links()).includes(token));
    assert.equal(b.hold(holdId).summary.includes(token), false);
    assert.equal((b.hold(holdId).view ?? "").includes(token), false);
  });

  it("a different input after the approval is held AGAIN (no standing approval)", async () => {
    const r = await b.call("artifact_share", { id: pageId, label: "Someone else", expiresInDays: 7, expect: await looked(b, pageId) }, { held: ["public_link"], key: "idem-key-share-2" });
    assert.equal(r.status, 202);
    assert.equal(b.links().length, 1);
  });

  it("the link opens through the SDK's viewer route; the document is served into a frame with a safe sandbox CSP", async () => {
    const shell = await b.viewer(`/v/live-artifacts/${token}`, { "sec-fetch-dest": "document" });
    assert.equal(shell.status, 200);
    assert.match(shell.headers.get("content-security-policy") ?? "", /frame-src https:\/\/views-e2e\.up\.railway\.app\/v\/live-artifacts\/_d\//);
    assert.equal(shell.headers.get("cache-control"), "no-store");
    // every asset of the shell is content-hashed (the path carries the first 16 hex digits of the sha256 of its body), so the
    // SDK's immutable caching on /_s/ is safe; the shell, the data and the document are never cached
    const html = await shell.text();
    const assets = [...html.matchAll(/(?:src|href)="(\/v\/live-artifacts\/_s\/[^"]+)"/g)].map((m) => m[1] as string);
    assert.equal(assets.length, 3, "shell script, shell css, tokens css");
    for (const path of assets) {
      const res = await b.viewer(path);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable", path);
      const body = await res.text();
      const hash = /([0-9a-f]{16})\.(?:js|css)$/.exec(path)?.[1];
      assert.equal(hash, createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16), `${path} carries the hash of its own content`);
    }
    const missing = await b.viewer("/v/live-artifacts/_s/0000000000000000.js");
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("cache-control"), "no-store", "an unknown asset is never cached as immutable");
    const dataRes = await b.viewer(`/v/live-artifacts/${token}/data`);
    assert.equal(dataRes.headers.get("cache-control"), "no-store");
    const data = (await dataRes.json()) as Record<string, any>;
    assert.equal(data.title, "Weekly operations");
    const doc = await b.viewer(`/v/live-artifacts/${data.doc}`, { "sec-fetch-dest": "iframe" });
    assert.equal(doc.status, 200, "the SDK's _d gate accepts our sandbox CSP (an unsafe one would be 502)");
    assert.match(doc.headers.get("content-security-policy") ?? "", /^sandbox allow-scripts;/);
    assert.match(await doc.text(), /<h1>v1<\/h1>/);
    const direct = await b.viewer(`/v/live-artifacts/${data.doc}`, { "sec-fetch-dest": "document" });
    assert.equal(direct.status, 404, "a document opened on its own is refused");
    assert.equal(Number(b.links()[0]?.views), 1, "the shell load was counted once");
  });

  it("artifact_link_revoke: needs no hold (a grant without public_link may revoke) and the address answers 404 at once", async () => {
    const linkId = String(b.links()[0]?.id);
    assert.equal((await b.viewer(`/v/live-artifacts/${token}/data`)).status, 200, "open before the revoke");
    const r = await b.call("artifact_link_revoke", { linkId }, { held: [], key: "idem-key-revoke-1" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.output, { revoked: true });
    const shell = await b.viewer(`/v/live-artifacts/${token}`, { "sec-fetch-dest": "document" });
    assert.equal(shell.status, 404);
    assert.equal((await b.viewer(`/v/live-artifacts/${token}/data`)).status, 404);
    const unknown = await b.call("artifact_link_revoke", { linkId: "lnk_01J00000000000000000000000" }, { held: [], key: "idem-key-revoke-2" });
    assert.equal(unknown.status, 403, "an unknown link looks like a link in a gallery the caller cannot reach");
    assert.equal(unknown.body.error.code, "scope_denied");
  });

  it("approve-then-swap: after the owner approved, a new version makes the retry page_changed (409) and no link is created", async () => {
    const page2 = await b.call("artifact_create", { ...PAGE, title: "Swap target" }, { held: [], key: "idem-key-create-swap" });
    const id = String(page2.body.output.id);
    const input = { id, label: "Client", expiresInDays: 7, expect: await looked(b, id) };
    const before = b.links().length;
    const held = await b.call("artifact_share", input, { held: ["public_link"], key: "idem-key-swap-1" });
    assert.equal(held.status, 202);
    assert.match(b.hold(String(held.body.holdId)).view ?? "", /The agent saw exactly this page/);
    await b.approve(String(held.body.holdId));
    // the agent swaps the page after the approval (nobody shares it yet, so the new version is live at once)
    const upd = await b.call("artifact_update", { id, view: { html: "<!doctype html><html><body>SWAPPED</body></html>" } }, { held: [], key: "idem-key-swap-upd" });
    assert.equal(upd.status, 200, JSON.stringify(upd.body));
    const retry = await b.call("artifact_share", input, { held: ["public_link"], key: "idem-key-swap-1" });
    assert.equal(retry.status, 409, JSON.stringify(retry.body));
    assert.equal(retry.body.error.code, "page_changed");
    assert.equal(b.links().length, before, "no link was created");
    // a new request for the new page is a new hold (the approval does not carry over)
    const fresh = await b.call("artifact_share", { id, label: "Client", expiresInDays: 7, expect: await looked(b, id) }, { held: ["public_link"], key: "idem-key-swap-2" });
    assert.equal(fresh.status, 202);
    assert.match(b.hold(String(fresh.body.holdId)).view ?? "", /Version 2: /);
  });

  it("artifact_publish: held, the approved retry promotes exactly the staged version; a staged title needs expect and stays staged otherwise", async () => {
    // a live link stages the next version (autoPublish owner)
    const e = await looked(b, pageId);
    const share = { id: pageId, label: "Second", expiresInDays: 1, expect: e };
    const h = await b.call("artifact_share", share, { held: ["public_link"], key: "idem-key-share-3" });
    await b.approve(String(h.body.holdId));
    assert.equal((await b.call("artifact_share", share, { held: ["public_link"], key: "idem-key-share-3" })).status, 200);
    const upd = await b.call("artifact_update", { id: pageId, title: "Weekly operations 2", view: { html: "<p>v2</p>" } }, { held: [], key: "idem-key-upd-1" });
    assert.equal(upd.body.output.staged, true);
    assert.equal(upd.body.output.liveVersion, 1);
    const staged = await looked(b, pageId, 2);
    const input = { id: pageId, version: 2, expect: { htmlSha256: staged.htmlSha256 } };
    const held = await b.call("artifact_publish", input, { held: ["public_link"], key: "idem-key-pub-1" });
    assert.equal(held.status, 202);
    const view = b.hold(String(held.body.holdId)).view ?? "";
    assert.match(view, /Version 2 waits for you and becomes live now \(version 1 is live\)\./);
    assert.match(view, /sha256 [0-9a-f]{16}/);
    assert.match(view, /The staged title "Weekly operations 2" stays staged and waits for you\./);
    await b.approve(String(held.body.holdId));
    const run = await b.call("artifact_publish", input, { held: ["public_link"], key: "idem-key-pub-1" });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.deepEqual(run.body.output, { liveVersion: 2, publishedKeys: [] });
    const after = await b.call("artifact_get", { id: pageId }, { held: [] });
    assert.equal(after.body.output.artifact.title, "Weekly operations", "the staged title was NOT promoted: it was not in expect");
    assert.equal(after.body.output.artifact.liveVersion, 2);
  });
});

describe("what the approval is bound to, on the real SDK", () => {
  let b: Booted;
  before(async () => {
    b = await boot(VIEWS);
  });
  after(async () => {
    await b?.stop();
  });
  const create = async (title: string, key: string, gallery?: string): Promise<string> => {
    const r = await b.call("artifact_create", { ...PAGE, title, ...(gallery ? { gallery } : {}), contract: { v: 1, inputs: [{ key: "n", kind: "push", label: "Numbers" }] } }, { held: [], key });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return String(r.body.output.id);
  };

  it("pushed data is bound: put A, build expect, put B → the hold says Do not approve; approved anyway, the run is 409 page_changed and no link (S4 review F1, F3)", async () => {
    const id = await create("Data page", "idem-key-data-1");
    const owner = await b.person();
    const sources = await b.call("artifact_get", { id, include: ["sources"] }, { held: [] });
    const digestOfN = sources.body.output.sources[0].digest;
    assert.equal((await owner.op("source_approve", { id, key: "n", digest: digestOfN, viewers: true })).status, 200, "the owner shows the pushed data to link viewers");
    const a = await b.call("artifact_data_put", { id, key: "n", data: { total: 1 } }, { held: [], key: "idem-key-put-a" });
    const e = await looked(b, id);
    assert.deepEqual(e.data, [{ key: "n", sha256: a.body.output.digest }]);
    await b.call("artifact_data_put", { id, key: "n", data: { total: 999 } }, { held: [], key: "idem-key-put-b" });
    const input = { id, expect: e };
    const held = await b.call("artifact_share", input, { held: ["public_link"], key: "idem-key-data-share" });
    assert.equal(held.status, 202, JSON.stringify(held.body));
    assert.equal((b.hold(String(held.body.holdId)).view ?? "").split("\n")[0], "Do not approve: this is not the page as it is now.");
    assert.match(b.hold(String(held.body.holdId)).view ?? "", /differs in: pushed data/);
    await b.approve(String(held.body.holdId));
    const r = await b.call("artifact_share", input, { held: ["public_link"], key: "idem-key-data-share" });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error.code, "page_changed");
    assert.equal(b.links().length, 0);
  });

  it("a caller that did not make the page: the hold says Do not approve, and the approval never runs, even after the page matches again", async () => {
    const id = await create("Shared page", "idem-key-shared-1", "shared");
    const stale = await looked(b, id, undefined, b.w.agent2);
    const rename = (title: string, key: string) => b.call("artifact_update", { id, title }, { held: [], key });
    assert.equal((await rename("Renamed", "idem-key-rename-1")).status, 200);
    const input = { id, expect: stale, label: "Stranger" };
    const held = await b.call("artifact_share", input, { held: ["public_link"], key: "idem-key-stranger-1", agent: b.w.agent2 });
    assert.equal(held.status, 202, "no early refusal for anybody: the SDK checks access and pause first");
    const view = b.hold(String(held.body.holdId)).view ?? "";
    assert.equal(view.split("\n")[0], "Do not approve: this is not the page as it is now.");
    await b.approve(String(held.body.holdId));
    assert.equal((await rename("Shared page", "idem-key-rename-2")).status, 200, "the agent makes expect true again");
    assert.deepEqual(await looked(b, id, undefined, b.w.agent2), stale, "the page equals the expect once more");
    const run = await b.call("artifact_share", input, { held: ["public_link"], key: "idem-key-stranger-1", agent: b.w.agent2 });
    assert.equal(run.status, 409, JSON.stringify(run.body));
    assert.equal(run.body.error.code, "page_changed");
    assert.equal(b.links().length, 0);
    // a page that matches is held without the warning and runs on approval (quiet on good)
    const ok = { id, expect: await looked(b, id, undefined, b.w.agent2), label: "Fine" };
    const h2 = await b.call("artifact_share", ok, { held: ["public_link"], key: "idem-key-stranger-2", agent: b.w.agent2 });
    assert.equal(h2.status, 202);
    assert.doesNotMatch(b.hold(String(h2.body.holdId)).view ?? "", /Do not approve/);
    await b.approve(String(h2.body.holdId));
    assert.equal((await b.call("artifact_share", ok, { held: ["public_link"], key: "idem-key-stranger-2", agent: b.w.agent2 })).status, 200);
  });
});

describe("review blockers: a hold that cannot be flagged, and a creator that lost its scope (real SDK)", () => {
  let b: Booted;
  before(async () => {
    b = await boot(VIEWS);
  });
  after(async () => {
    await b?.stop();
  });
  const appDb = <T>(fn: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(join(b.dir, "app.db"));
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };
  const countHolds = (): number => Number((appDb((db) => db.prepare("SELECT COUNT(*) AS c FROM tb_receipts WHERE status = 'held'").get()) as { c: number }).c);
  const create = async (title: string, key: string, agent?: `agt_${string}`): Promise<string> => {
    const r = await b.call("artifact_create", { ...PAGE, title, gallery: "shared" }, { held: [], key, ...(agent ? { agent } : {}) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return String(r.body.output.id);
  };

  it("a failed la_hold_flag write: no hold is created, the call fails, no approval exists and no link is made", async () => {
    const id = await create("Flag target", "idem-key-flag-1");
    const stale = await looked(b, id, undefined, b.w.agent2);
    assert.equal((await b.call("artifact_update", { id, title: "Renamed" }, { held: [], key: "idem-key-flag-2" })).status, 200);
    appDb((db) => db.exec("CREATE TRIGGER la_inject BEFORE INSERT ON la_hold_flag BEGIN SELECT RAISE(ABORT, 'injected write failure'); END"));
    try {
      const holds = countHolds();
      const input = { id, expect: stale, label: "Injected" };
      const r = await b.call("artifact_share", input, { held: ["public_link"], key: "idem-key-flag-3", agent: b.w.agent2 });
      assert.equal(r.status, 500, JSON.stringify(r.body));
      assert.notEqual(r.status, 202);
      assert.equal(countHolds(), holds, "the SDK created no hold");
      // there is nothing to approve; the same call again fails the same way and never runs
      const again = await b.call("artifact_share", input, { held: ["public_link"], key: "idem-key-flag-3", agent: b.w.agent2 });
      assert.equal(again.status, 500);
      assert.equal(b.links().length, 0, "no link");
    } finally {
      appDb((db) => db.exec("DROP TRIGGER la_inject"));
    }
  });

  it("the owner removed the agent's access to its OWN gallery: scope_denied, identical to an unknown page, for artifact_share and artifact_publish", async () => {
    const id = String((await b.call("artifact_create", { ...PAGE, title: "Own gallery page" }, { held: [], key: "idem-key-own-1" })).body.output.id);
    const guess = { version: 1, htmlSha256: "sha256:00", title: "guess", data: [], sourcesSha256: "sha256:guess" };
    const owner = await b.person();
    const set = (access: string | null) => owner.op("tb.scopes_set", { agent: b.w.agent, type: "gallery", id: b.w.agent, access });
    assert.equal((await set(null)).status, 200);
    try {
      const unknownId = "art_01J0000000000000000000ZZZZ";
      for (const [op, mk] of [
        ["artifact_share", (pid: string) => ({ id: pid, expect: guess })],
        ["artifact_publish", (pid: string) => ({ id: pid, version: 1, expect: { htmlSha256: "sha256:00" } })],
      ] as const) {
        const real = await b.call(op, mk(id), { held: ["public_link"], key: `idem-key-own-${op}-1` });
        const unknown = await b.call(op, mk(unknownId), { held: ["public_link"], key: `idem-key-own-${op}-2` });
        assert.equal(real.status, 403, `${op}: ${JSON.stringify(real.body)}`);
        assert.equal(real.body.error.code, "scope_denied");
        assert.deepEqual([real.status, real.body.error.code, real.body.error.message], [unknown.status, unknown.body.error.code, unknown.body.error.message], op);
      }
    } finally {
      await set("manage");
    }
    assert.equal(b.links().length, 0);
  });

  it("a creator whose scope was revoked learns nothing from a guessed expect: the same answer and code as for an unknown page", async () => {
    const id = await create("Creator page", "idem-key-scope-1", b.w.agent2);
    const owner = await b.person();
    const revoke = await owner.op("tb.scopes_set", { agent: b.w.agent2, type: "gallery", id: "shared", access: null });
    assert.equal(revoke.status, 200, JSON.stringify(revoke.body));
    const guess = { version: 1, htmlSha256: "sha256:00", title: "guess", data: [], sourcesSha256: "sha256:guess" };
    const real = await b.call("artifact_share", { id, expect: guess }, { held: ["public_link"], key: "idem-key-scope-2", agent: b.w.agent2 });
    const unknown = await b.call("artifact_share", { id: "art_01J0000000000000000000ZZZZ", expect: guess }, { held: ["public_link"], key: "idem-key-scope-3", agent: b.w.agent2 });
    assert.equal(real.status, 403, JSON.stringify(real.body));
    assert.equal(real.body.error.code, "scope_denied");
    assert.deepEqual([real.status, real.body.error.code, real.body.error.message], [unknown.status, unknown.body.error.code, unknown.body.error.message]);
    const pub = await b.call("artifact_publish", { id, version: 1, expect: { htmlSha256: "sha256:00" } }, { held: ["public_link"], key: "idem-key-scope-4", agent: b.w.agent2 });
    assert.equal(pub.body.error.code, "scope_denied");
    // restore the access (the owner can give it back)
    await owner.op("tb.scopes_set", { agent: b.w.agent2, type: "gallery", id: "shared", access: "contribute" });
    assert.equal(b.links().length, 0);
  });
});

describe("a paused agent (real SDK)", () => {
  let b: Booted;
  before(async () => {
    b = await boot(VIEWS, { pausedAgent: true });
  });
  after(async () => {
    await b?.stop();
  });
  it("gets the paused answer, never page_changed, whatever it guesses: same code for a real and an unknown page", async () => {
    // the paused agent cannot create a page itself: an unpaused agent makes a real one in the shared gallery
    const made = await b.call("artifact_create", { ...PAGE, title: "Real page", gallery: "shared" }, { held: [], key: "idem-key-paused-real", agent: b.w.agent2 });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const realId = String(made.body.output.id);
    const unknownId = "art_01J0000000000000000000ZZZZ";
    const guess = { version: 1, htmlSha256: "sha256:00", title: "guess", data: [], sourcesSha256: "sha256:guess" };
    const answers: [number, string, string][] = [];
    for (const [op, mk] of [
      ["artifact_share", (id: string) => ({ id, expect: guess })],
      ["artifact_publish", (id: string) => ({ id, version: 1, expect: { htmlSha256: "sha256:00" } })],
    ] as const) {
      for (const [which, id] of [["real", realId], ["unknown", unknownId]] as const) {
        const r = await b.call(op, mk(id), { held: ["public_link"], key: `idem-key-paused-${op}-${which}` });
        assert.ok(r.status >= 400 && r.status !== 409, `${op} ${which}: ${JSON.stringify(r.body)}`);
        assert.notEqual(r.body.error.code, "page_changed");
        answers.push([r.status, r.body.error.code, r.body.error.message]);
      }
    }
    assert.match(answers[0]?.[1] ?? "", /paused/, "the paused answer");
    for (const a of answers) assert.deepEqual(a, answers[0], "the same answer for a real and an unknown page, on both ops");
    assert.equal(b.links().length, 0);
  });
});

describe("the owner on the real SDK person route", () => {
  let b: Booted;
  before(async () => {
    b = await boot(VIEWS);
  });
  after(async () => {
    await b?.stop();
  });
  it("link_create (no hold) → the address opens → links_list shows it without the address → link_revoke → the address answers 404 at once", async () => {
    const created = await b.call("artifact_create", PAGE, { held: [], key: "idem-key-create-1" });
    const id = String(created.body.output.id);
    const owner = await b.person();
    const made = await owner.op("link_create", { id, label: "Board", expiresInDays: 30, pin: 1 }, { key: "own-link-1" });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const out = made.body.output as { linkId: string; url: string; expiresAt: string };
    const token = out.url.split("/").pop() ?? "";
    assert.equal(token.length, 47);
    assert.equal(b.links()[0]?.created_by_type, "person");
    assert.equal((await b.viewer(`/v/live-artifacts/${token}`, { "sec-fetch-dest": "document" })).status, 200);
    // the same request again is the same answer, and no second link
    const same = await owner.op("link_create", { id, label: "Board", expiresInDays: 30, pin: 1 }, { key: "own-link-1" });
    assert.equal(same.body.output.url, out.url);
    assert.equal(b.links().length, 1);
    const list = await owner.op("links_list", {});
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.output.items.map((i: Record<string, unknown>) => [i.label, i.status, i.pinVersion]), [["Board", "active", 1]]);
    assert.ok(!JSON.stringify(list.body).includes(token), "the list has no address");
    const revoked = await owner.op("link_revoke", { linkId: out.linkId });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.deepEqual(revoked.body.output, { revoked: true });
    assert.equal((await b.viewer(`/v/live-artifacts/${token}`, { "sec-fetch-dest": "document" })).status, 404);
    assert.equal((await owner.op("links_list", {})).body.output.items[0].status, "revoked");
  });
  it("fires on bad: no idempotency key, no CSRF header and an agent-only op on the person route are refused with their codes", async () => {
    const created = await b.call("artifact_create", { ...PAGE, title: "Second" }, { held: [], key: "idem-key-create-2" });
    const id = String(created.body.output.id);
    const owner = await b.person();
    const noKey = await owner.op("link_create", { id }, { key: null });
    assert.equal(noKey.status, 400);
    assert.equal(noKey.body.error.code, "idempotency_key_required");
    const noCsrf = await owner.op("links_list", {}, { csrf: false });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.body.error.code, "csrf_invalid");
    const agentOnly = await owner.op("artifact_share", { id, expect: { version: 1, htmlSha256: "x", title: "Second" } }, { key: "own-link-2" });
    assert.ok(agentOnly.status >= 400, "artifact_share is an agent op");
    assert.equal(b.links().filter((l) => l.artifact_id === id).length, 0, "none of them made a link");
  });
});

describe("links on the real SDK (no viewer address in the slice)", () => {
  let b: Booted;
  before(async () => {
    b = await boot(null);
  });
  after(async () => {
    await b?.stop();
  });
  it("view_origin_missing (409) for artifact_share once the owner approved; no link is created", async () => {
    const created = await b.call("artifact_create", PAGE, { held: [], key: "idem-key-create-1" });
    const id = String(created.body.output.id);
    const input = { id, expect: await looked(b, id) };
    const first = await b.call("artifact_share", input, { held: ["public_link"], key: "idem-key-share-1" });
    assert.equal(first.status, 202);
    await b.approve(String(first.body.holdId));
    const run = await b.call("artifact_share", input, { held: ["public_link"], key: "idem-key-share-1" });
    assert.equal(run.status, 409, JSON.stringify(run.body));
    assert.equal(run.body.error.code, "view_origin_missing");
    assert.equal(b.links().length, 0);
  });
  it("the hold text says the page cannot be shared yet once a call has seen the missing address", async () => {
    // the share above ran (and refused) after the hold; the next hold knows
    const created = await b.call("artifact_create", { ...PAGE, title: "Another" }, { held: [], key: "idem-key-create-2" });
    const id = String(created.body.output.id);
    const held = await b.call("artifact_share", { id, expect: await looked(b, id) }, { held: ["public_link"], key: "idem-key-share-2" });
    assert.equal(held.status, 202);
    assert.equal((b.hold(String(held.body.holdId)).view ?? "").split("\n")[0], "This page cannot be shared yet (no viewer address); approving changes nothing.");
  });
  it("without a views origin the viewer route serves nothing: 503, not a shell with a 'self' fallback", async () => {
    const res = await b.viewer("/v/live-artifacts/tbv_nope", { "sec-fetch-dest": "document" });
    assert.equal(res.status, 503);
    assert.doesNotMatch(res.headers.get("content-security-policy") ?? "", /'self'/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });
});

describe("pause (the SDK answers before the handler)", () => {
  let b: Booted;
  before(async () => {
    b = await boot(VIEWS, { paused: true });
  });
  after(async () => {
    await b?.stop();
  });
  it("a paused workspace: the viewer route answers 503 paused, where an unpaused instance answers 404 for the same unknown address", async () => {
    const res = await b.viewer("/v/live-artifacts/tbv_nope", { "sec-fetch-dest": "document" });
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "paused");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", "the floor is on the SDK's own answer");
  });
});
