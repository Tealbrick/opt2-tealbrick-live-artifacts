// S4 on the REAL SDK (miniapp-sdk 0.1.26): the app runs under `startApp` behind a fake bridge that signs slices, grants and
// call proofs. Covers what unit tests with a fake context cannot: the SDK holds the call (holdId, listed hold with the
// owner's text), the approved retry runs ONCE and returns the address (L27), link_needs_hold for a grant without
// public_link, view_origin_missing from the slice, and the viewer route as the SDK serves it (prefix /v/live-artifacts,
// GET only, headers). Quiet on good and fire on bad: each case asserts the exact status and code.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { digest, type Ed25519KeyPair, generateKeyPair, type HoldFamily, signCallProof, signGrant, signKeySetStatement, signSlice, ulid, VIEWER_HEADER_FLOOR } from "@opt2-tealbrick/manifest";
import { decideHold, defineApp, type Json, type PersonPrincipal, type RunningApp, startApp } from "@opt2-tealbrick/miniapp-sdk";
import { definition, manifest } from "../src/app.ts";
import { setDocKey } from "../src/viewer.ts";

const nowS = () => Math.floor(Date.now() / 1000);
const VIEWS = "https://views-e2e.up.railway.app";

interface World {
  root: Ed25519KeyPair;
  portal: Ed25519KeyPair;
  bridgeKey: Ed25519KeyPair;
  keySet: string;
  ws: `ws_${string}`;
  brg: `brg_${string}`;
  ins: `ins_${string}`;
  per: `per_${string}`;
  agent: `agt_${string}`;
}

interface Booted {
  running: RunningApp;
  bridge: Server;
  dir: string;
  w: World;
  call(op: string, input: Json, opts?: { held?: HoldFamily[]; key?: string; agent?: `agt_${string}` }): Promise<{ status: number; body: Record<string, any> }>;
  hold(id: string): { status: string; view: string | null; summary: string };
  approve(id: string): Promise<unknown>;
  viewer(path: string, headers?: Record<string, string>, method?: string): Promise<Response>;
  links(): Record<string, unknown>[];
  stop(): Promise<void>;
}

async function boot(viewUrl: string | null): Promise<Booted> {
  const [root, portal, bridgeKey] = await Promise.all([generateKeyPair(), generateKeyPair(), generateKeyPair()]);
  const keySet = await signKeySetStatement({ iss: "tb:portal-root", aud: "tb:portal-keys", seq: 1, iat: nowS(), keys: [{ jwk: portal.publicJwk, status: "active" }] }, root);
  const w: World = { root, portal, bridgeKey, keySet, ws: `ws_${ulid()}`, brg: `brg_${ulid()}`, ins: `ins_${ulid()}`, per: `per_${ulid()}`, agent: `agt_${ulid()}` };
  const self = `tb:ins:${w.ins}` as const;
  const slice = await signSlice(
    {
      iss: "tb:portal",
      sub: self,
      aud: self,
      iat: nowS(),
      ws: w.ws,
      v: 1,
      rev: 1,
      ins: w.ins,
      product: "live-artifacts",
      portalKeys: [{ jwk: portal.publicJwk, status: "active" }],
      bridge: { id: w.brg, keys: [bridgeKey.publicJwk], publicUrl: "https://bridge-e2e.up.railway.app", ...(viewUrl ? { viewUrl } : {}) },
      pause: { workspace: false, agents: [], instances: [] },
      revoked: { jtis: [] },
      personNbf: 0,
      grants: [],
      agents: [{ id: w.agent, name: "Scout", mode: "free", status: "active" }],
      portalKeySet: keySet,
    } as Parameters<typeof signSlice>[0],
    portal,
  );
  const waiting: ServerResponse[] = [];
  let bridgePort = 0;
  const bridge = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    const url = new URL(req.url ?? "/", "http://x");
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    if (url.pathname === "/tb/v1/claim") return json(200, { ins: w.ins, bridge: { id: w.brg, publicKey: bridgeKey.publicJwk, internalUrl: `http://127.0.0.1:${bridgePort}` }, slice });
    if (url.pathname === "/tb/v1/status") {
      if (body?.sliceRevision !== 1) return json(200, { slice, sliceRevision: 1, keysRev: 0 });
      waiting.push(res);
      setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(204);
          res.end();
        }
      }, 1000).unref();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => bridge.listen(0, "127.0.0.1", r));
  bridgePort = (bridge.address() as { port: number }).port;
  const dir = mkdtempSync(join(tmpdir(), "la-links-e2e-"));
  setDocKey(null);
  const running = await startApp(
    defineApp(definition),
    { TB_INSTANCE_ID: w.ins, TB_ENROL_CODE: "tbe_e2e", TB_BRIDGE_URL: `http://127.0.0.1:${bridgePort}`, TB_PORTAL_KEYS: JSON.stringify({ keys: [portal.publicJwk] }), TB_DATA_DIR: dir, TB_DATA_EPHEMERAL: "1", TB_LOG_LEVEL: "error" },
    { portalRootKeys: [root.publicJwk], port: 0 } as Parameters<typeof startApp>[2],
  );
  for (let i = 0; i < 200 && running.status() !== "ok"; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(running.status(), "ok");
  const owner = { type: "person", id: w.per, ws: w.ws, instance: w.ins } as PersonPrincipal;
  const base = `http://127.0.0.1:${running.port}`;
  const readDb = <T>(fn: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(join(dir, "app.db"), { readOnly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };
  return {
    running,
    bridge,
    dir,
    w,
    async call(op, input, opts = {}) {
      const agent = opts.agent ?? w.agent;
      const grant = await signGrant(
        { iss: "tb:portal", sub: `tb:agt:${agent}`, aud: self, iat: nowS(), ws: w.ws, cnf: { brg: w.brg }, crud: ["create", "read", "update", "delete"], mode: "free", held: opts.held ?? [], caps: {}, wf: [], polrev: 1 },
        portal,
      );
      const jti = (JSON.parse(Buffer.from(grant.split(".")[1] as string, "base64url").toString("utf8")) as { jti: string }).jti;
      const proof = await signCallProof({ iss: `tb:brg:${w.brg}`, sub: `tb:agt:${agent}`, aud: self, iat: nowS(), call: `call_${ulid()}`, gjti: jti, op, in: digest(input), ctx: digest({}) }, bridgeKey);
      const res = await fetch(`${base}/tb/v1/ops/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${grant}`, "tb-call": proof },
        body: JSON.stringify({ input, context: {}, ...(opts.key ? { idempotencyKey: opts.key } : {}) }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    },
    hold: (id) => readDb((db) => db.prepare("SELECT status, view, summary FROM tb_receipts WHERE id = ?").get(id) as { status: string; view: string | null; summary: string }),
    approve: (id) => decideHold(owner, { holdId: id as `hld_${string}`, decision: "approve" }),
    viewer: (path, headers = {}, method = "GET") => fetch(`${base}${path}`, { method, headers }),
    links: () => readDb((db) => db.prepare("SELECT * FROM la_link WHERE kind = 'viewer' ORDER BY created_at").all() as Record<string, unknown>[]),
    async stop() {
      await running.stop();
      bridge.closeAllConnections();
      await new Promise<void>((r) => bridge.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const PAGE = { title: "Weekly operations", view: { html: "<!doctype html><html><body><h1>v1</h1></body></html>" } };

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
    for (const op of ["artifact_share", "artifact_publish"] as const) {
      const input: Json = op === "artifact_share" ? { id: pageId } : { id: pageId, version: 1, data: [{ key: "n", digest: "sha256:x" }] };
      const r = await b.call(op, input, { held: [], key: `idem-key-needs-${op}` });
      assert.equal(r.status, 403, `${op}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error.code, "link_needs_hold");
    }
    assert.equal(b.links().length, 0, "no link was created");
    // a grant that holds OTHER families only is just as short
    const other = await b.call("artifact_share", { id: pageId }, { held: ["destructive", "money"], key: "idem-key-needs-other" });
    assert.equal(other.body.error?.code, "link_needs_hold");
  });

  let token = "";
  it("held flow: the SDK holds artifact_share (holdId, listed, owner text); approval runs the SAME call once and returns the address (L27)", async () => {
    const input = { id: pageId, label: "Novak Dental", expiresInDays: 7 };
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
    assert.match(h.view ?? "", /7 days after you approve/);
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
    assert.equal(b.links().length, 1, "approved: exactly one link");
    assert.equal(b.hold(holdId).status, "run");

    // the sealed answer replays (the address stays available for the retrying agent) and creates no second link
    const replay = await b.call("artifact_share", input, { held: ["public_link"], key: "idem-key-share-1" });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.output.url, out.url);
    assert.equal(b.links().length, 1);
    // the app keeps only a digest of the address
    assert.ok(!JSON.stringify(b.links()).includes(token));
    assert.equal(b.hold(holdId).summary.includes(token), false);
  });

  it("a different input after the approval is held AGAIN (no standing approval)", async () => {
    const r = await b.call("artifact_share", { id: pageId, label: "Someone else", expiresInDays: 7 }, { held: ["public_link"], key: "idem-key-share-2" });
    assert.equal(r.status, 202);
    assert.equal(b.links().length, 1);
  });

  it("the link opens through the SDK's viewer route; the document is served into a frame with a safe sandbox CSP", async () => {
    const shell = await b.viewer(`/v/live-artifacts/${token}`, { "sec-fetch-dest": "document" });
    assert.equal(shell.status, 200);
    assert.match(shell.headers.get("content-security-policy") ?? "", /frame-src https:\/\/views-e2e\.up\.railway\.app\/v\/live-artifacts\/_d\//);
    assert.equal(shell.headers.get("cache-control"), "no-store");
    const asset = /src="(\/v\/live-artifacts\/_s\/[^"]+\.js)"/.exec(await shell.text())?.[1] ?? "";
    const js = await b.viewer(asset);
    assert.equal(js.status, 200, asset);
    // (SDK 0.1.26 answers these assets `no-store` although the app marks them immutable: its floor wins for cache-control.
    //  Performance only; not asserted here.)
    const data = (await (await b.viewer(`/v/live-artifacts/${token}/data`)).json()) as Record<string, any>;
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

  it("artifact_publish: held, the approved retry promotes exactly the staged version", async () => {
    // a live link stages the next version (autoPublish owner)
    const share = { id: pageId, label: "Second", expiresInDays: 1 };
    const h = await b.call("artifact_share", share, { held: ["public_link"], key: "idem-key-share-3" });
    await b.approve(String(h.body.holdId));
    assert.equal((await b.call("artifact_share", share, { held: ["public_link"], key: "idem-key-share-3" })).status, 200);
    const upd = await b.call("artifact_update", { id: pageId, view: { html: "<p>v2</p>" } }, { held: [], key: "idem-key-upd-1" });
    assert.equal(upd.body.output.staged, true);
    assert.equal(upd.body.output.liveVersion, 1);
    const input = { id: pageId, version: 2 };
    const held = await b.call("artifact_publish", input, { held: ["public_link"], key: "idem-key-pub-1" });
    assert.equal(held.status, 202);
    const view = b.hold(String(held.body.holdId)).view ?? "";
    assert.match(view, /Version 2 \(the version that waits for you\) becomes live; now version 1 is live\./);
    assert.match(view, /sha256 [0-9a-f]{16}/);
    await b.approve(String(held.body.holdId));
    const run = await b.call("artifact_publish", input, { held: ["public_link"], key: "idem-key-pub-1" });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.deepEqual(run.body.output, { liveVersion: 2, publishedKeys: [] });
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
    const input = { id };
    const first = await b.call("artifact_share", input, { held: ["public_link"], key: "idem-key-share-1" });
    assert.equal(first.status, 202);
    await b.approve(String(first.body.holdId));
    const run = await b.call("artifact_share", input, { held: ["public_link"], key: "idem-key-share-1" });
    assert.equal(run.status, 409, JSON.stringify(run.body));
    assert.equal(run.body.error.code, "view_origin_missing");
    assert.equal(b.links().length, 0);
  });
});
