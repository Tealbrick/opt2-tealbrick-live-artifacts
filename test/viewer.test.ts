// Viewer path (DESIGN §5.2, §5.7): uniform 404, headers, version binding, data visibility, ETag, view counts, previews.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { opaqueDigest, ulid } from "@opt2-tealbrick/manifest";
import type { Db, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { bindScopeDb, definition, handlers, setClock, viewUrlOf } from "../src/app.ts";
import { createPreview, docTicket, documentCsp, handleViewer, newToken, PREVIEW_TTL_MS, PREVIEWS_PER_ARTIFACT, shellCsp, TOKEN_RE, type ViewerConfig } from "../src/viewer.ts";
import { injectHelper, SHELL_HTML, stripFonts, TB_HELPER } from "../src/viewer-assets.ts";
import { AGENT_A, CRUD, ctxFor, type Instance, migratedDb, OWNER } from "./helpers.ts";

type Out = Record<string, any>;
const CFG: ViewerConfig = { viewOrigin: "https://views-abc.up.railway.app", mainOrigin: "https://bridge-abc.up.railway.app", workspaceName: "Acme", docKey: "test-doc-key-0123456789abcdef" };
let db: Db;
let instances: Instance[];
let now: number;
let seq = 1_700_000_000_000;
const A = () => ctxFor(db, AGENT_A, { [AGENT_A.id]: CRUD.manage }, instances);
const get = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  handleViewer(db, new Request(`http://app.internal${path}`, { method, headers: { "sec-fetch-dest": path.includes("/_d/") ? "iframe" : "document", ...headers } }), CFG, now);
/** the document path the shell would frame (from /data) */
const docPath = async (tok: string): Promise<string> => `/v/live-artifacts/${((await get(`/v/live-artifacts/${tok}/data`).json()) as Out).doc}`;
const linkIdOf = (tok: string): string => String(db.prepare("SELECT id FROM la_link WHERE token_digest = ?").get(opaqueDigest(tok))?.id);
const run = async (opId: keyof typeof handlers, input: unknown, ctx: OpContext): Promise<Out> => (await handlers[opId].run(input as never, ctx)) as Out;

function link(id: string, opts: { pin?: number | null; expires?: number; revoked?: boolean; kind?: "viewer" | "preview" } = {}): string {
  const token = newToken();
  db.prepare(
    "INSERT INTO la_link (id, artifact_id, kind, token_digest, label, created_by_type, created_by_id, created_by_name, created_at, expires_at, revoked_at, pin_version) VALUES (?, ?, ?, ?, '', 'person', 'per_x', 'Owner', ?, ?, ?, ?)",
  ).run(`lnk_${ulid(++seq)}`, id, opts.kind ?? "viewer", opaqueDigest(token), now, opts.expires ?? now + 86_400_000, opts.revoked ? now : null, opts.pin ?? null);
  return token;
}
async function page(): Promise<string> {
  const out = await run(
    "artifact_create",
    {
      title: "Blocked work",
      view: { html: "<!doctype html><html><head><title>x</title></head><body>v1</body></html>" },
      contract: {
        v: 1,
        inputs: [
          { key: "n", kind: "push" },
          { key: "t", kind: "read", product: "kanban", op: "issues_list" },
          { key: "secret", kind: "read", product: "knowledge", op: "recall", input: { query: "salaries" } },
        ],
      },
    },
    A(),
  );
  return out.id as string;
}

beforeEach(async () => {
  db = migratedDb();
  instances = [];
  now = Date.UTC(2026, 9, 17, 12, 0, 0);
  setClock(() => now);
  bindScopeDb(db);
  await definition.onStart?.({ db, scopes: { instances: ctxFor(db, OWNER, {}, instances).scopes.instances } } as never);
});

describe("tokens and the uniform 404", () => {
  it("tokens are tbv_ + 43 base64url chars and only their digest is stored", async () => {
    const t = newToken();
    assert.match(t, TOKEN_RE);
    const id = await page();
    const tok = link(id);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM la_link WHERE token_digest = ?").get(tok)?.c, 0, "token itself is never stored");
  });
  it("a valid link serves the shell (quiet on good)", async () => {
    const id = await page();
    const r = get(`/v/live-artifacts/${link(id)}`);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), SHELL_HTML);
  });
  it("unknown, malformed, expired, revoked, archived and deleted links answer the SAME 404 (fires on bad)", async () => {
    const id = await page();
    const expired = link(id, { expires: now - 1 });
    const revoked = link(id, { revoked: true });
    const archivedId = await page();
    const archived = link(archivedId);
    db.prepare("UPDATE la_artifact SET status = 'archived' WHERE id = ?").run(archivedId);
    const bodies = new Set<string>();
    // a forged or expired document ticket answers the same 404
    for (const p of [`/v/live-artifacts/_d/${docTicket({ ...CFG, docKey: "other" }, linkIdOf(expired), 1, now)}`, `/v/live-artifacts/_d/${docTicket(CFG, linkIdOf(revoked), 1, now)}`, "/v/live-artifacts/_d/x"]) {
      const r = get(p);
      bodies.add(`${r.status}|${await r.text()}|${r.headers.get("content-type")}`);
    }
    for (const tok of [newToken(), "tbv_short", "nope", expired, revoked, archived]) {
      for (const suffix of ["", "/data", "/d/1"]) {
        const r = get(`/v/live-artifacts/${tok}${suffix}`);
        assert.equal(r.status, 404, `${tok}${suffix}`);
        bodies.add(`${r.status}|${await r.text()}|${r.headers.get("content-type")}`);
      }
    }
    assert.equal(bodies.size, 1, "identical status, body and type");
  });
  it("only GET; other paths 404", async () => {
    const id = await page();
    const tok = link(id);
    assert.equal(get(`/v/live-artifacts/${tok}`, {}, "POST").status, 405);
    assert.equal(get(`/v/live-artifacts/${tok}/x`).status, 404);
    assert.equal(get("/a/live-artifacts/").status, 404);
  });
});

describe("headers (app floor; the bridge adds its own, LA-1)", () => {
  it("shell: strict CSP, framed by nobody; previews may be framed by the main origin only", async () => {
    const id = await page();
    const r = get(`/v/live-artifacts/${link(id)}`);
    for (const [k, v] of Object.entries({ "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" })) assert.equal(r.headers.get(k), v, k);
    const csp = r.headers.get("content-security-policy") ?? "";
    assert.equal(csp, shellCsp(CFG, false));
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /frame-src https:\/\/views-abc\.up\.railway\.app\/v\/live-artifacts\//);
    assert.match(shellCsp(CFG, true), /frame-ancestors https:\/\/bridge-abc\.up\.railway\.app/);
    assert.equal(r.headers.get("set-cookie"), null);
  });
  it("document: sandbox (opaque origin), no network, framed only by the views origin", async () => {
    const id = await page();
    const tok = link(id);
    const path = await docPath(tok);
    assert.ok(!path.includes(tok), "the document URL never contains the link token (agent code can read its URL)");
    const r = get(path);
    const csp = r.headers.get("content-security-policy") ?? "";
    assert.equal(csp, documentCsp(CFG));
    for (const d of ["sandbox allow-scripts", "connect-src 'none'", "form-action 'none'", "frame-src 'none'", "worker-src 'none'", "default-src 'none'", "frame-ancestors https://views-abc.up.railway.app"])
      assert.ok(csp.includes(d), d);
    assert.ok(!/allow-same-origin|allow-top-navigation|allow-popups|allow-forms/.test(csp), "no sandbox escape tokens");
    const html = await r.text();
    assert.ok(html.startsWith("<!doctype html><script>"), "the helper is the first script, right after the doctype");
    assert.ok(html.endsWith("<body>v1</body></html>"));
  });
});

describe("documents only inside a frame (Fetch Metadata)", () => {
  it("serves the document to an iframe request and refuses a direct open or a request without Sec-Fetch-Dest", async () => {
    const id = await page();
    const path = await docPath(link(id));
    assert.equal(get(path).status, 200);
    assert.equal(get(path, { "sec-fetch-dest": "document" }).status, 404);
    const bare = handleViewer(db, new Request(`http://app.internal${path}`), CFG, now);
    assert.equal(bare.status, 404, "no header → refused (fail closed)");
  });
  it("a document ticket expires (10–15 min) and dies with its link", async () => {
    const id = await page();
    const tok = link(id);
    const path = await docPath(tok);
    now += 16 * 60_000;
    assert.equal(get(path).status, 404, "expired ticket");
    now -= 16 * 60_000;
    db.prepare("UPDATE la_link SET revoked_at = ?").run(now);
    assert.equal(get(path).status, 404, "revoked link → ticket dead at once");
  });
});

describe("version binding", () => {
  it("a link reads only its own version (live, or the pinned one), even with a valid ticket for another version", async () => {
    const id = await page();
    await run("artifact_update", { id, view: { html: "<p>v2</p>" } }, A());
    const live = link(id);
    assert.equal(get(await docPath(live)).status, 200);
    assert.ok((await docPath(live)).includes(".2."), "the live link's ticket names version 2");
    assert.equal(get(`/v/live-artifacts/_d/${docTicket(CFG, linkIdOf(live), 1, now)}`).status, 404, "an older version is not reachable");
    const pinned = link(id, { pin: 1 });
    assert.equal(await (get(await docPath(pinned))).text().then((t) => t.endsWith("<body>v1</body></html>")), true);
    assert.equal(get(`/v/live-artifacts/_d/${docTicket(CFG, linkIdOf(pinned), 2, now)}`).status, 404);
  });
});

describe("data visibility (DESIGN §4.4, R3)", () => {
  it("viewer links show only approved sources marked for link viewers; previews show every approved source; staged data never", async () => {
    const id = await page();
    await run("artifact_data_put", { id, key: "n", data: { total: 3 } }, A());
    db.prepare("UPDATE la_source SET approved_digest = digest WHERE artifact_id = ? AND key = 't'").run(id); // owner approved t (viewers off)
    db.prepare("INSERT INTO la_snapshot (artifact_id, key, data_json, bytes, fetched_at, status) VALUES (?, 't', ?, 9, ?, 'ok')").run(id, JSON.stringify(["task"]), now);
    db.prepare("INSERT INTO la_snapshot (artifact_id, key, data_json, bytes, fetched_at, status) VALUES (?, 'secret', ?, 9, ?, 'ok')").run(id, JSON.stringify(["SALARY"]), now); // never approved
    const viewer = link(id);
    const v1 = (await get(`/v/live-artifacts/${viewer}/data`).json()) as Out;
    assert.deepEqual(v1.sources, {}, "a viewer link learns nothing about sources it may not show (no key, no state)");
    db.prepare("UPDATE la_source SET viewers = 1 WHERE artifact_id = ?").run(id);
    const v2 = (await get(`/v/live-artifacts/${viewer}/data`).json()) as Out;
    assert.deepEqual([v2.sources.n.data, v2.sources.t.data, "secret" in v2.sources], [{ total: 3 }, ["task"], false], "an unapproved source is not listed even with viewers on");
    const preview = createPreview(db, id, null, { type: "person", id: OWNER.id, name: "Owner" }, now).token;
    const p = (await get(`/v/live-artifacts/${preview}/data`).json()) as Out;
    assert.deepEqual([p.preview, p.sources.n.data, "data" in p.sources.secret, p.sources.secret.status], [true, { total: 3 }, false, "not_approved"], "the owner's preview lists every source, data only when approved");
    // staged data (a shared page with autoPublish owner) stays out of every view
    await run("artifact_data_put", { id, key: "n", data: { total: 99 } }, A());
    const v3 = (await get(`/v/live-artifacts/${viewer}/data`).json()) as Out;
    assert.deepEqual(v3.sources.n.data, { total: 3 });
    assert.ok(!JSON.stringify(v3).includes("SALARY"));
  });
  it("ETag: same data → 304; changed data → 200 with a new tag", async () => {
    const id = await page();
    const tok = link(id);
    const r1 = get(`/v/live-artifacts/${tok}/data`);
    const tag = r1.headers.get("etag") ?? "";
    assert.match(tag, /^"[0-9a-f]{32}"$/);
    assert.equal(get(`/v/live-artifacts/${tok}/data`, { "if-none-match": tag }).status, 304);
    await run("artifact_update", { id, title: "New title" }, A());
    assert.equal(get(`/v/live-artifacts/${tok}/data`, { "if-none-match": tag }).status, 304, "a staged title is not shown (shared page)");
    await run("publish_version", { id, version: 1 }, ctxFor(db, OWNER, {}, instances));
    const r3 = get(`/v/live-artifacts/${tok}/data`, { "if-none-match": tag });
    assert.equal(r3.status, 200);
    assert.notEqual(r3.headers.get("etag"), tag);
  });
  it("banner fields: title, workspace, made by; stale after 2 intervals without data", async () => {
    const id = await page();
    db.prepare("UPDATE la_artifact SET refresh_every_s = 300, refresh_approved = 1, refresh_state = 'on' WHERE id = ?").run(id);
    db.prepare("UPDATE la_source SET approved_digest = digest, viewers = 1 WHERE artifact_id = ?").run(id);
    db.prepare("INSERT INTO la_snapshot (artifact_id, key, data_json, bytes, fetched_at, status) VALUES (?, 't', '[]', 2, ?, 'ok')").run(id, now);
    const tok = link(id);
    const fresh = (await get(`/v/live-artifacts/${tok}/data`).json()) as Out;
    assert.deepEqual([fresh.title, fresh.workspace, fresh.madeBy, fresh.stale, fresh.live], ["Blocked work", "Acme", AGENT_A.name, false, 1]);
    now += 601_000;
    assert.equal(((await get(`/v/live-artifacts/${tok}/data`).json()) as Out).stale, true);
  });
});

describe("view counts and previews", () => {
  it("counts shell loads of viewer links per day (no IP, no user agent); previews are not counted", async () => {
    const id = await page();
    const tok = link(id);
    get(`/v/live-artifacts/${tok}`);
    get(`/v/live-artifacts/${tok}`);
    get(`/v/live-artifacts/${tok}`, { "sec-fetch-dest": "empty" }); // a prefetch / unfurl bot: not counted
    handleViewer(db, new Request(`http://app.internal/v/live-artifacts/${tok}`), CFG, now); // no Fetch Metadata: not counted
    get(`/v/live-artifacts/${tok}/data`);
    const row = db.prepare("SELECT views, last_seen_day FROM la_link WHERE kind = 'viewer'").get();
    assert.deepEqual([Number(row?.views), row?.last_seen_day], [2, "2026-10-17"]);
    assert.deepEqual(db.prepare("SELECT day, count FROM la_view_day").all().map((r) => [r.day, Number(r.count)]), [["2026-10-17", 2]]);
    assert.deepEqual(Object.keys(db.prepare("SELECT * FROM la_view_day").get() ?? {}).sort(), ["count", "day", "link_id"], "counts only");
  });
  it("preview ticket: needs the viewer address (view_origin_missing), lasts 10 minutes, shows the staged version", async () => {
    const id = await page();
    const owner = ctxFor(db, OWNER, {}, instances);
    await assert.rejects(run("artifact_preview_ticket", { id }, owner), (e: { code?: string }) => e.code === "view_origin_missing");
    assert.equal(viewUrlOf({ viewUrl: "http://insecure" }), null);
    for (const bad of ["https://a.example; script-src *", "https://a b", "https://u@a.example", "https://a.example/x", "https://a.example\n"]) assert.equal(viewUrlOf({ viewUrl: bad }), null, bad);
    assert.equal(viewUrlOf({ viewUrl: "https://views-abc.up.railway.app:8443" }), "https://views-abc.up.railway.app:8443");
    const withView = Object.assign(ctxFor(db, OWNER, {}, instances), { viewUrl: CFG.viewOrigin });
    link(id); // the page is shared → the next update is staged
    await run("artifact_update", { id, view: { html: "<p>v2 staged</p>" } }, A());
    const t = await run("artifact_preview_ticket", { id }, withView);
    assert.equal(t.version, 2);
    assert.match(t.url, /^https:\/\/views-abc\.up\.railway\.app\/v\/live-artifacts\/tbv_[A-Za-z0-9_-]{43}$/);
    const token = String(t.url).split("/").pop() ?? "";
    const pdoc = await docPath(token);
    assert.ok(pdoc.includes(".2."), "preview shows the staged version");
    assert.equal(get(pdoc).status, 200);
    assert.match(get(pdoc).headers.get("content-security-policy") ?? "", /frame-ancestors https:\/\/views-abc\.up\.railway\.app https:\/\/bridge-abc\.up\.railway\.app/, "the owner UI may sit above the preview shell");
    for (let k = 0; k < PREVIEWS_PER_ARTIFACT + 2; k++) await run("artifact_preview_ticket", { id }, withView);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM la_link WHERE kind = 'preview'").get()?.c), PREVIEWS_PER_ARTIFACT, "at most 3 live previews per page");
    now += PREVIEW_TTL_MS + 1;
    assert.equal(get(`/v/live-artifacts/${token}`).status, 404, "expired after 10 minutes");
  });
});

describe("assets", () => {
  it("shell assets are content-hashed and immutable; tokens.css has no @font-face", async () => {
    const paths = [...SHELL_HTML.matchAll(/(?:href|src)="\/v\/live-artifacts\/(_s\/[^"]+)"/g)].map((m) => m[1]);
    assert.equal(paths.length, 3);
    for (const p of paths) {
      const r = get(`/v/live-artifacts/${p}`);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get("cache-control") ?? "", /immutable/);
    }
    assert.equal(stripFonts("a{}@font-face { src: url(x) }b{}"), "a{}b{}");
    assert.equal(get("/v/live-artifacts/_s/other.js").status, 404);
  });
  it("injectHelper: right after a leading doctype, else at the start; never searches the document", () => {
    const tag = `<script>${TB_HELPER}</script>`;
    assert.equal(injectHelper("<!DOCTYPE html><p>x</p>"), `<!DOCTYPE html>${tag}<p>x</p>`);
    assert.equal(injectHelper("<html><head></head></html>"), `${tag}<html><head></head></html>`);
    assert.equal(injectHelper("<!-- <head> --><p>x</p>"), `${tag}<!-- <head> --><p>x</p>`, "a <head> inside a comment is ignored");
    const hostile = "<head ".repeat(50_000);
    const t0 = performance.now();
    injectHelper(hostile);
    assert.ok(performance.now() - t0 < 50, "linear on hostile input (review PR #2, finding 1)");
  });
});
