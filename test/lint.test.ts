// Write-time HTML lint (advice, not the boundary; DESIGN §5.3): quiet on a self-contained page, fires on outside loads.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isExternal, lintErrors, lintHtml } from "../src/lint.ts";

const GOOD = `<!doctype html><html><head><style>body{font:14px sans-serif;background:url(data:image/png;base64,AAAA)}</style></head>
<body><h1>Blocked work</h1><img src="data:image/svg+xml;base64,PHN2Zy8+" alt=""><a href="#top">top</a>
<script>tb.onData((d) => { document.body.dataset.n = String(d.tasks?.length ?? 0); }); tb.ready();</script></body></html>`;

const codes = (html: string) => lintHtml(html).map((i) => `${i.level}:${i.code}`);

describe("lintHtml", () => {
  it("is quiet on a self-contained page", () => {
    assert.deepEqual(lintHtml(GOOD), []);
  });
  it("refuses frames, base, meta refresh, @import and outside resources", () => {
    assert.ok(codes('<iframe src="x"></iframe>').includes("error:embedded_frame"));
    assert.ok(codes("<OBJECT data=x></OBJECT>").includes("error:embedded_frame"));
    assert.ok(codes('<base href="https://evil.example/">').includes("error:base_tag"));
    assert.ok(codes('<meta http-equiv="refresh" content="0;url=https://evil.example">').includes("error:meta_refresh"));
    assert.ok(codes("<style>@import 'x.css';</style>").includes("error:css_import"));
    for (const html of [
      '<script src="https://cdn.example/x.js"></script>',
      "<img src=//evil.example/p.gif>",
      '<link rel="stylesheet" href="https://evil.example/s.css">',
      "<div style=\"background:url('https://evil.example/b.png')\"></div>",
      '<img srcset="data:image/png;base64,AA 1x, https://evil.example/2x.png 2x">',
    ])
      assert.ok(codes(html).includes("error:external_resource"), html);
  });
  it("advises on network APIs, forms and relative files (no refusal)", () => {
    const items = lintHtml('<script>fetch("/x")</script><form></form><img src="logo.png">');
    assert.deepEqual(lintErrors(items), []);
    assert.deepEqual(items.map((i) => i.code).sort(), ["form", "network_api", "relative_resource"]);
  });
  it("isExternal: data/blob/fragments are inside; any scheme or // is outside", () => {
    for (const v of ["data:x", "blob:x", "#a", "", "logo.png", "/v/x"]) assert.equal(isExternal(v), false, v);
    for (const v of ["https://a", "HTTP://a", "//a", "javascript:alert(1)", "ftp://a"]) assert.equal(isExternal(v), true, v);
  });
});
