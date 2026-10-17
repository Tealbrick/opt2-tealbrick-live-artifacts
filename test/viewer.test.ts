// Viewer path (DESIGN §5.2, §5.7): uniform 404, headers, version binding, data visibility, ETag, view counts, previews.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { opaqueDigest, ulid } from "@opt2-tealbrick/manifest";
import type { Db, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { bindScopeDb, definition, handlers, setClock } from "../src/app.ts";
import { createPreview, docTicket, documentCsp, endLinksAfterRestore, handleViewer, httpsOrigin, isRestorePending, markRestored, newToken, PREVIEW_TTL_MS, PREVIEWS_PER_ARTIFACT, scriptlessDocumentCsp, shellCsp, TOKEN_RE, VIEW_PREFIX, type ViewerConfig } from "../src/viewer.ts";
import { injectHelper, SHELL_HTML, stripFonts, TB_HELPER } from "../src/viewer-assets.ts";
import { AGENT_A, CRUD, ctxFor, type Instance, memorySecrets, migratedDb, OWNER } from "./helpers.ts";

type Out = Record<string, any>;
const CFG: ViewerConfig = { viewOrigin: "https://views-abc.up.railway.app", mainOrigin: "https://bridge-abc.up.railway.app", workspaceName: "Acme", docKey: "test-doc-key-0123456789abcdef" };
let db: Db;
let instances: Instance[];
let now: number;
let seq = 1_700_000_000_000;
const A = () => ctxFor(db, AGENT_A, { [AGENT_A.id]: CRUD.manage }, instances);
/** The request the SDK hands the viewer route: the public path WITHOUT the /v/live-artifacts prefix (SDK 0.1.26). */
const stripped = (path: string): string => (path.startsWith(`${VIEW_PREFIX}/`) ? path.slice(VIEW_PREFIX.length) : path);
const request = (path: string, headers: Record<string, string> = {}, method = "GET"): Request => new Request(`http://live-artifacts.views.internal${stripped(path)}`, { method, headers });
const get = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  handleViewer(db, request(path, { "sec-fetch-dest": path.includes("/_d/") ? "iframe" : "document", ...headers }, method), CFG, now);
/** the document path the shell would frame (from /data) */
const docPath = async (tok: string): Promise<string> => `/v/live-artifacts/${((await get(`/v/live-artifacts/${tok}/data`).json()) as Out).doc}`;
const linkIdOf = (tok: string): string => String(db.prepare("SELECT id FROM la_link WHERE token_digest = ?").get(opaqueDigest(tok))?.id);
const run = async (opId: keyof typeof handlers, input: unknown, ctx: OpContext): Promise<Out> => (await handlers[opId].run(input as never, ctx)) as Out;

const setHtml = (id: string, html: string): void => void db.prepare("UPDATE la_version SET html = ? WHERE artifact_id = ? AND n = 1").run(Buffer.from(html, "utf8"), id);
function link(id: string, opts: { pin?: number | null; expires?: number; revoked?: boolean; kind?: "viewer" | "preview"; scriptsOk?: boolean } = {}): string {
  const token = newToken();
  db.prepare(
    "INSERT INTO la_link (id, artifact_id, kind, token_digest, label, created_by_type, created_by_id, created_by_name, created_at, expires_at, revoked_at, pin_version, scripts_ok) VALUES (?, ?, ?, ?, '', 'person', 'per_x', 'Owner', ?, ?, ?, ?, ?)",
  ).run(`lnk_${ulid(++seq)}`, id, opts.kind ?? "viewer", opaqueDigest(token), now, opts.expires ?? now + 86_400_000, opts.revoked ? now : null, opts.pin ?? null, opts.scriptsOk === false ? 0 : 1);
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
  await definition.onStart?.({ db, secrets: memorySecrets(), scopes: { instances: ctxFor(db, OWNER, {}, instances).scopes.instances } } as never);
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

describe("no views origin", () => {
  it("serves nothing: 503 with the floor and no 'self' fallback in any CSP (quiet: the same request with an origin is 200)", async () => {
    const id = await page();
    const tok = link(id);
    const none: ViewerConfig = { ...CFG, viewOrigin: null };
    assert.equal(get(`/v/live-artifacts/${tok}`).status, 200);
    for (const path of [`/v/live-artifacts/${tok}`, `/v/live-artifacts/${tok}/data`, "/v/live-artifacts/_s/x.js", `/v/live-artifacts/_d/${docTicket(none, linkIdOf(tok), 1, now)}`, "/v/live-artifacts/tbv_nope"]) {
      const r = handleViewer(db, request(path, { "sec-fetch-dest": path.includes("/_d/") ? "iframe" : "document" }), none, now);
      assert.equal(r.status, 503, path);
      assert.doesNotMatch(r.headers.get("content-security-policy") ?? "", /frame-(src|ancestors)[^;]*'self'/, path);
      assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    }
    assert.match(shellCsp(none, false), /frame-src 'none'/);
    assert.match(documentCsp(none), /frame-ancestors 'none'/);
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
  it("document (a page that runs a script): sandbox allow-scripts (opaque origin), connect-src none, framed only by the views origin", async () => {
    const id = await page();
    setHtml(id, "<!doctype html><html><head><title>x</title></head><body>v1<script>window.x=1</script></body></html>");
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
    assert.ok(html.startsWith("<!DOCTYPE html><script>"), "the helper is the first script, right after the doctype");
    assert.ok(html.endsWith("<body>v1<script>window.x=1</script></body></html>"));
  });
});

describe("scriptless render (C239)", () => {
  const SCRIPT_PAGE = '<!doctype html><html><body><h1 id="h">Scripts</h1><div onclick="x()">c</div><script>tb.ready()</script></body></html>';
  const FREE_PAGE = '<!doctype html><html><head><style>h1{color:#123}</style></head><body><h1 id="h">Totals</h1><p>Total: <b data-tb-text="n.total">?</b></p><p data-tb-text="n.rows.1.name">?</p><i data-tb-text="n.missing">gone</i></body></html>';
  async function dataPage(html: string): Promise<{ id: string; tok: string }> {
    const id = await page();
    setHtml(id, html);
    db.prepare("UPDATE la_source SET approved_digest = digest, viewers = 1 WHERE artifact_id = ? AND key = 'n'").run(id);
    db.prepare("INSERT OR REPLACE INTO la_snapshot (artifact_id, key, data_json, bytes, status, fetched_at) VALUES (?, 'n', ?, 10, 'ok', ?)").run(
      id,
      JSON.stringify({ total: 42, rows: [{ name: "a" }, { name: "<b>x</b>&amp;" }] }),
      now,
    );
    return { id, tok: link(id) };
  }
  it("a page without script gets the scriptless CSP: script-src none and a sandbox without allow-scripts, no helper", async () => {
    const { tok } = await dataPage(FREE_PAGE);
    const r = get(await docPath(tok));
    const csp = r.headers.get("content-security-policy") ?? "";
    assert.equal(csp, scriptlessDocumentCsp(CFG));
    assert.match(csp, /^sandbox; /);
    assert.match(csp, /script-src 'none'/);
    assert.ok(!/allow-scripts|unsafe-inline'[^;]*;[^;]*script/.test(csp.split("; ").filter((d) => d.startsWith("sandbox") || d.startsWith("script-src")).join(";")), "no allow-scripts");
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /img-src data:(;|$)/);
    const html = await r.text();
    assert.ok(!html.includes("<script"), "no helper and no script element");
    assert.ok(html.includes("<h1 id=\"h\">Totals</h1>"));
  });
  it("the data is inlined at serve time: values as escaped text, unknown paths empty, nothing is fetched", async () => {
    const { tok } = await dataPage(FREE_PAGE);
    const html = await get(await docPath(tok)).text();
    assert.match(html, /<b data-tb-text="n\.total">42<\/b>/);
    assert.match(html, /<p data-tb-text="n\.rows\.1\.name">&lt;b&gt;x&lt;\/b&gt;&amp;amp;<\/p>/, "agent data is text, never markup");
    assert.match(html, /<i data-tb-text="n\.missing"><\/i>/);
    assert.ok(!/fetch|XMLHttpRequest/.test(html));
    // /data tells the shell: scriptless, no scripts, and a revision of the inlined data
    const d = (await get(`/v/live-artifacts/${tok}/data`).json()) as Out;
    assert.equal(d.scriptless, true);
    assert.equal(d.runsScripts, false);
    assert.match(d.docRev, /^sha256:/);
    const before = d.docRev;
    db.prepare("UPDATE la_snapshot SET data_json = ? WHERE key = 'n'").run(JSON.stringify({ total: 43 }));
    const d2 = (await get(`/v/live-artifacts/${tok}/data`).json()) as Out;
    assert.notEqual(d2.docRev, before, "the shell reloads the frame when the inlined data changes");
    assert.match(await get(await docPath(tok)).text(), /<b data-tb-text="n\.total">43<\/b>/);
  });
  it("data never goes into a raw-text element, and a page that binds nothing has no docRev", async () => {
    const { tok } = await dataPage('<!doctype html><html><head><style data-tb-text="n.total">a{color:red}</style></head><body><p data-tb-text="n.total">?</p></body></html>');
    const html = await get(await docPath(tok)).text();
    assert.ok(html.includes("<style data-tb-text=\"n.total\">a{color:red}</style>"), "the style text is untouched");
    const plain = await dataPage("<!doctype html><html><body>static</body></html>");
    assert.equal(((await get(`/v/live-artifacts/${plain.tok}/data`).json()) as Out).docRev, null);
  });
  it("a page that runs scripts keeps them for a link approved for scripts, and the shell is told", async () => {
    const id = await page();
    setHtml(id, SCRIPT_PAGE);
    const tok = link(id);
    const r = get(await docPath(tok));
    assert.equal(r.headers.get("content-security-policy"), documentCsp(CFG));
    const html = await r.text();
    assert.ok(html.includes("<script>tb.ready()</script>") && html.includes('onclick="x()"'));
    const d = (await get(`/v/live-artifacts/${tok}/data`).json()) as Out;
    assert.equal(d.scriptless, false);
    assert.equal(d.runsScripts, true);
  });
  it("a link NOT approved for scripts (scripts_ok = 0) gets the scriptless render even when the page gained scripts", async () => {
    const id = await page();
    setHtml(id, SCRIPT_PAGE);
    const tok = link(id);
    db.prepare("UPDATE la_link SET scripts_ok = 0 WHERE token_digest = ?").run(opaqueDigest(tok));
    const r = get(await docPath(tok));
    assert.equal(r.headers.get("content-security-policy"), scriptlessDocumentCsp(CFG));
    const html = await r.text();
    assert.ok(!html.includes("<script") && !html.includes("onclick"), `scripts and handlers are removed: ${html}`);
    assert.ok(html.includes("Scripts</h1>"), "the rest of the page stays");
    const d = (await get(`/v/live-artifacts/${tok}/data`).json()) as Out;
    assert.equal(d.scriptless, true);
    assert.equal(d.runsScripts, true, "the owner still sees that the page itself runs scripts");
  });
  it("fail closed: a link inserted WITHOUT an explicit script approval never runs scripts (scripts_ok defaults to 0)", async () => {
    const id = await page();
    setHtml(id, SCRIPT_PAGE);
    const tok = newToken();
    db.prepare(
      "INSERT INTO la_link (id, artifact_id, kind, token_digest, label, created_by_type, created_by_id, created_by_name, created_at, expires_at) VALUES (?, ?, 'viewer', ?, '', 'person', 'per_x', 'Owner', ?, ?)",
    ).run(`lnk_${ulid(++seq)}`, id, opaqueDigest(tok), now, now + 86_400_000);
    assert.equal(Number(db.prepare("SELECT scripts_ok FROM la_link WHERE token_digest = ?").get(opaqueDigest(tok))?.scripts_ok), 0);
    const r = get(await docPath(tok));
    assert.equal(r.headers.get("content-security-policy"), scriptlessDocumentCsp(CFG));
    const html = await r.text();
    assert.ok(!html.includes("<script") && !html.includes("onclick"), html);
    assert.equal(((await get(`/v/live-artifacts/${tok}/data`).json()) as Out).scriptless, true);
    // and only the explicit approval changes that
    db.prepare("UPDATE la_link SET scripts_ok = 1 WHERE token_digest = ?").run(opaqueDigest(tok));
    assert.equal(get(await docPath(tok)).headers.get("content-security-policy"), documentCsp(CFG));
  });
  it("the owner's preview of a page without scripts is the same scriptless render", async () => {
    const { id } = await dataPage(FREE_PAGE);
    const tok = link(id, { kind: "preview" });
    const r = get(await docPath(tok));
    assert.equal(r.headers.get("content-security-policy"), scriptlessDocumentCsp(CFG, true));
    assert.match(await r.text(), /<b data-tb-text="n\.total">42<\/b>/);
  });
});

describe("after a restore every link is ended (S6 review S3-3)", () => {
  it("until the app recorded the restore no link opens; then every link and preview is ended once, with a note on the page", async () => {
    const id = await page();
    const a1 = link(id);
    const a2 = link(id);
    const prev = link(id, { kind: "preview" });
    const gone = link(id, { revoked: true });
    assert.equal(get(`/v/live-artifacts/${a1}`).status, 200);
    markRestored();
    try {
      assert.ok(isRestorePending());
      for (const t of [a1, a2, prev, gone]) assert.equal(get(`/v/live-artifacts/${t}`).status, 404, "nothing opens while the restore is pending");
      assert.equal(endLinksAfterRestore(db, now), 2, "two active viewer links were ended");
    } finally {
      assert.ok(!isRestorePending());
    }
    for (const t of [a1, a2, prev, gone]) assert.equal(get(`/v/live-artifacts/${t}`).status, 404);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM la_link WHERE kind = 'preview'").get()?.c), 0);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM la_link WHERE kind = 'viewer' AND revoked_at IS NULL").get()?.c), 0);
    assert.match(String(db.prepare("SELECT summary FROM la_activity WHERE artifact_id = ? AND by_id = 'restore'").get(id)?.summary), /2 link\(s\) ended because the data was restored/);
    assert.equal(endLinksAfterRestore(db, now), 0, "nothing more to end");
    // a link made after the restore works
    assert.equal(get(`/v/live-artifacts/${link(id)}`).status, 200);
  });
});

describe("sanitized once at write time, stored per version (S6 review)", () => {
  const stored = (id: string, n = 1): string | null => {
    const r = db.prepare("SELECT served_html FROM la_version WHERE artifact_id = ? AND n = ?").get(id, n);
    return r?.served_html === null || r?.served_html === undefined ? null : Buffer.from(r.served_html as Uint8Array).toString("utf8");
  };
  it("artifact_create and artifact_update store the sanitized page; the viewer serves exactly that", async () => {
    const id = await page();
    assert.ok(stored(id)?.includes("<body>v1</body>"), String(stored(id)));
    await run("artifact_update", { id, view: { html: '<!doctype html><html><body><p>v2</p><a href="https://x.test/a">l</a><!-- c --></body></html>' } }, A());
    const v2 = stored(id, 2) ?? "";
    assert.ok(v2.includes("<p>v2</p>") && !v2.includes("x.test") && !v2.includes("<!--"), v2);
    const tok = link(id);
    db.prepare("UPDATE la_artifact SET live_version = 2 WHERE id = ?").run(id);
    const html = await get(await docPath(tok)).text();
    assert.ok(html.includes("<p>v2</p>") && !html.includes("x.test"));
    // proof that the stored text is what is served (not a fresh sanitize): a marker only the column has
    db.prepare("UPDATE la_version SET served_html = ? WHERE artifact_id = ? AND n = 2").run(Buffer.from("<!DOCTYPE html><html><head></head><body>FROM-THE-COLUMN</body></html>"), id);
    assert.ok((await get(await docPath(tok)).text()).includes("FROM-THE-COLUMN"));
  });
  it("a row without the stored result (older row, restore) is sanitized at serve time", async () => {
    const id = await page();
    db.prepare("UPDATE la_version SET html = ?, served_html = NULL WHERE artifact_id = ? AND n = 1").run(Buffer.from('<p>x</p><link rel="prerender" href="https://x.test/p">'), id);
    const html = await get(await docPath(link(id))).text();
    assert.ok(html.includes("<p>x</p>") && !html.includes("x.test"));
  });
  it("a page that cannot be sanitized is refused at write time with a clear error, and nothing is stored", async () => {
    const id = await page();
    for (const html of ["<div>".repeat(5000), `<a ${Array.from({ length: 1000 }, (_, i) => `a${i}`).join(" ")}>x</a>`]) {
      await assert.rejects(run("artifact_update", { id, view: { html } }, A()), (e: { code?: string; httpStatus?: number }) => e.code === "view_not_servable" && e.httpStatus === 422);
    }
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM la_version WHERE artifact_id = ?").get(id)?.c), 1);
    await assert.rejects(run("artifact_create", { title: "Deep", view: { html: "<div>".repeat(5000) } }, A()), (e: { code?: string }) => e.code === "view_not_servable");
  });
});

describe("every served agent document is sanitized (C238)", () => {
  const HOSTILE =
    '<!doctype html><html><head><link rel="prerender" href="https://canary.test/p"><base href="https://canary.test/"><meta http-equiv="refresh" content="0;url=https://canary.test/m"></head>' +
    '<body><h1 id="m">marker</h1><img src="//canary.test/i.png"><script type="speculationrules">{"prerender":[{"source":"list","urls":["https://canary.test/s"]}]}</script><script>window.ran=1</script></body></html>';
  const set = (id: string, html: string): void => void db.prepare("UPDATE la_version SET html = ?, served_html = NULL WHERE artifact_id = ? AND n = 1").run(Buffer.from(html, "utf8"), id);
  it("a viewer link and an owner preview both get the page without outside markup, with the marker and the scripts", async () => {
    const id = await page();
    set(id, HOSTILE);
    for (const kind of ["viewer", "preview"] as const) {
      const tok = link(id, { kind });
      const r = get(await docPath(tok));
      assert.equal(r.status, 200);
      const html = await r.text();
      assert.ok(!html.includes("canary.test"), `${kind}: ${html}`);
      assert.ok(!/<link|<base|http-equiv|speculationrules/i.test(html), kind);
      assert.ok(html.includes('<h1 id="m">marker</h1>') && html.includes("window.ran=1"), kind);
      assert.ok(html.includes(TB_HELPER), "the helper is still injected");
    }
  });
  it("a page that cannot be made safe is replaced by the fixed document, with the same headers", async () => {
    const id = await page();
    set(id, "<div>".repeat(5000));
    const r = get(await docPath(link(id)));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-security-policy"), scriptlessDocumentCsp(CFG), "the fixed document runs no script");
    assert.match(await r.text(), /This page cannot be shown/);
  });
});

describe("documents only inside a frame (Fetch Metadata)", () => {
  it("serves the document to an iframe request and refuses a direct open or a request without Sec-Fetch-Dest", async () => {
    const id = await page();
    const path = await docPath(link(id));
    assert.equal(get(path).status, 200);
    assert.equal(get(path, { "sec-fetch-dest": "document" }).status, 404);
    const bare = handleViewer(db, request(path), CFG, now);
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
    handleViewer(db, request(`/v/live-artifacts/${tok}`), CFG, now); // no Fetch Metadata: not counted
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
    await assert.rejects(run("artifact_preview_ticket", { id }, Object.assign(ctxFor(db, OWNER, {}, instances), { viewUrl: "http://insecure" })), (e: { code?: string }) => e.code === "view_origin_missing", "an http address is no viewer address");
    assert.equal(httpsOrigin("http://insecure"), null);
    for (const bad of ["https://a.example; script-src *", "https://a b", "https://u@a.example", "https://a.example/x", "https://a.example\n"]) assert.equal(httpsOrigin(bad), null, bad);
    assert.equal(httpsOrigin("https://views-abc.up.railway.app:8443"), "https://views-abc.up.railway.app:8443");
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
    assert.ok(performance.now() - t0 < 500, "linear on hostile input (review PR #2, finding 1: the old regex took ~4 s)");
  });
});
