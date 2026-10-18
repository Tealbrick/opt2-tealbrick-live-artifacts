// Real-SDK test harness: the app under `startApp` behind a fake bridge that signs slices, grants and call proofs.
// Shared by the S4 link tests and the S6 backup test.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { digest, type Ed25519KeyPair, generateKeyPair, type HoldFamily, signCallProof, signGrant, signKeySetStatement, signSlice, signTicket, ulid } from "@opt2-tealbrick/manifest";
import { decideHold, defineApp, type Json, type PersonPrincipal, type RunningApp, startApp } from "@opt2-tealbrick/miniapp-sdk";
import { definition } from "../src/app.ts";
import { resetRestoreEpoch, setDocKey } from "../src/viewer.ts";

export const nowS = () => Math.floor(Date.now() / 1000);
export const VIEWS = "https://views-e2e.up.railway.app";

export interface World {
  root: Ed25519KeyPair;
  portal: Ed25519KeyPair;
  bridgeKey: Ed25519KeyPair;
  keySet: string;
  ws: `ws_${string}`;
  brg: `brg_${string}`;
  ins: `ins_${string}`;
  per: `per_${string}`;
  agent: `agt_${string}`;
  /** a second agent that did not make the pages (it reaches the shared gallery only) */
  agent2: `agt_${string}`;
}

export interface Booted {
  running: RunningApp;
  bridge: Server;
  dir: string;
  w: World;
  call(op: string, input: Json, opts?: { held?: HoldFamily[]; key?: string; agent?: `agt_${string}` }): Promise<{ status: number; body: Record<string, any> }>;
  hold(id: string): { status: string; view: string | null; summary: string };
  approve(id: string): Promise<unknown>;
  viewer(path: string, headers?: Record<string, string>, method?: string): Promise<Response>;
  /** the owner on the real SDK person route: a launch ticket redeemed for a session cookie, then ops with CSRF + Origin */
  person(): Promise<{ op(name: string, input: Json, opts?: { key?: string | null; csrf?: boolean }): Promise<{ status: number; body: Record<string, any> }> }>;
  links(): Record<string, unknown>[];
  stop(): Promise<void>;
}

export async function boot(viewUrl: string | null, opts: { paused?: boolean; pausedAgent?: boolean; env?: Record<string, string>; dir?: string; keepDir?: boolean; world?: World } = {}): Promise<Booted> {
  const [root, portal, bridgeKey] = opts.world ? [opts.world.root, opts.world.portal, opts.world.bridgeKey] : await Promise.all([generateKeyPair(), generateKeyPair(), generateKeyPair()]);
  const keySet = opts.world?.keySet ?? (await signKeySetStatement({ iss: "tb:portal-root", aud: "tb:portal-keys", seq: 1, iat: nowS(), keys: [{ jwk: portal.publicJwk, status: "active" }] }, root));
  const w: World = opts.world ?? { root, portal, bridgeKey, keySet, ws: `ws_${ulid()}`, brg: `brg_${ulid()}`, ins: `ins_${ulid()}`, per: `per_${ulid()}`, agent: `agt_${ulid()}`, agent2: `agt_${ulid()}` };
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
      pause: { workspace: opts.paused === true, agents: opts.pausedAgent ? [w.agent] : [], instances: [] },
      revoked: { jtis: [] },
      personNbf: 0,
      grants: [],
      agents: [
        { id: w.agent, name: "Scout", mode: "free", status: "active" },
        { id: w.agent2, name: "Clerk", mode: "free", status: "active" },
      ],
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
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "la-links-e2e-"));
  setDocKey(null);
  // a real deployment has TB_DATA_DIR in the process environment; the app's afterRestore hook reads it there
  process.env.TB_DATA_DIR = dir;
  resetRestoreEpoch(); // a real boot is a new process: no cached restore epoch from an earlier boot in this test process
  const running = await startApp(
    defineApp(definition),
    { TB_INSTANCE_ID: w.ins, TB_ENROL_CODE: "tbe_e2e", TB_BRIDGE_URL: `http://127.0.0.1:${bridgePort}`, TB_PORTAL_KEYS: JSON.stringify({ keys: [portal.publicJwk] }), TB_DATA_DIR: dir, TB_DATA_EPHEMERAL: "1", TB_LOG_LEVEL: "error", ...opts.env },
    { portalRootKeys: [root.publicJwk], port: 0 } as Parameters<typeof startApp>[2],
  );
  for (let i = 0; i < 200 && running.status() !== "ok"; i++) await new Promise((r) => setTimeout(r, 25));
  if (running.status() !== "ok") {
    // do not leave the app and the fake bridge listening when the boot failed (a hung test process)
    await running.stop().catch(() => {});
    bridge.closeAllConnections();
    await new Promise<void>((r) => bridge.close(() => r()));
    throw new Error(`the app did not become ok: ${running.status()}`);
  }
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
  let stopped = false;
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
    async person() {
      const ticket = await signTicket({ iss: "tb:portal", sub: `tb:per:${w.per}`, aud: self, iat: nowS(), ws: w.ws, pur: "launch", path: "/" }, portal);
      const launch = await fetch(`${base}/a/live-artifacts/tb/launch`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ticket }) });
      assert.equal(launch.status, 303, "the launch ticket is redeemed");
      const cookie = (launch.headers.get("set-cookie") ?? "").split(";")[0] as string;
      const session = (await (await fetch(`${base}/a/live-artifacts/tb/v1/session`, { headers: { cookie } })).json()) as { csrf: string; idempotencyRequired: string[] };
      assert.ok(session.idempotencyRequired.includes("link_create"), "the session lists link_create as idempotency required");
      return {
        async op(name, input, o = {}) {
          const headers: Record<string, string> = { "content-type": "application/json", cookie, origin: base };
          if (o.csrf !== false) headers["tb-csrf"] = session.csrf;
          const key = o.key === undefined ? undefined : o.key;
          const res = await fetch(`${base}/a/live-artifacts/tb/v1/ops/${name}`, { method: "POST", headers, body: JSON.stringify({ input, ...(key ? { idempotencyKey: key } : {}) }) });
          return { status: res.status, body: (await res.json()) as Record<string, any> };
        },
      };
    },
    links: () => readDb((db) => db.prepare("SELECT * FROM la_link WHERE kind = 'viewer' ORDER BY created_at").all() as Record<string, unknown>[]),
    async stop() {
      if (stopped) return; // safe to call twice (a failed `before` leaves it to `after`)
      stopped = true;
      await running.stop();
      bridge.closeAllConnections();
      await new Promise<void>((r) => bridge.close(() => r()));
      if (!opts.keepDir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

