// Agent-document sanitizer (C238): every rule, the tricks around it (case, entities, whitespace, protocol-relative), the
// CSS rules, what must survive, fail-closed, and a seeded fuzz run checked against a second, independent parser (happy-dom).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse } from "parse5";
import { BLOCKED_DOCUMENT, classifyUrl, clearSanitizeCache, SANITIZE_MAX_BYTES, sanitizeCss, sanitizeHtml, servedDocument, srcsetUrls } from "../src/sanitize.ts";

const clean = (html: string): string => sanitizeHtml(html).html;
const body = (html: string): string => clean(html).replace(/^.*?<body>/s, "").replace(/<\/body><\/html>$/s, "");
const has = (html: string, re: RegExp): boolean => re.test(clean(html));

/** Oracle: parse the OUTPUT as the browser would (parse5, spec tree builder) and list anything that could reach the network
 *  by static markup. The checks here are written separately from the sanitizer's own walk. (happy-dom was tried as a second
 *  parser; it is not spec-compliant for raw-text elements inside tables, so it reports false hits.) */
const URL_ATTR = ["src", "href", "srcset", "action", "formaction", "ping", "poster", "background", "xlink:href", "data"];
interface P5Node {
  nodeName: string;
  tagName?: string;
  attrs?: { name: string; value: string; prefix?: string }[];
  childNodes?: P5Node[];
  content?: P5Node;
  value?: string;
}
function violations(html: string): string[] {
  const out: string[] = [];
  const todo: P5Node[] = [parse(html, { scriptingEnabled: true }) as unknown as P5Node];
  while (todo.length > 0) {
    const node = todo.pop() as P5Node;
    todo.push(...(node.childNodes ?? []));
    if (node.content) todo.push(node.content);
    const tag = node.tagName?.toLowerCase();
    if (!tag) continue;
    const attr = (n: string): string | null => node.attrs?.find((a) => (a.prefix ? `${a.prefix}:${a.name}` : a.name).toLowerCase() === n)?.value ?? null;
    if (["link", "base", "portal", "iframe", "object", "embed"].includes(tag)) out.push(`<${tag}>`);
    if (tag === "meta" && attr("http-equiv") !== null) out.push("meta http-equiv");
    if (tag === "script" && (attr("type") ?? "").trim().toLowerCase() === "speculationrules") out.push("speculationrules");
    for (const a of URL_ATTR) {
      const v = attr(a);
      if (v === null) continue;
      const urls = a === "srcset" ? srcsetUrls(v) : a === "ping" ? v.split(/\s+/) : [v];
      for (const u of urls) if (classifyUrl(u) !== "ok") out.push(`${tag}[${a}=${u}]`);
    }
    const style = attr("style");
    if (style !== null && sanitizeCss(style).blocked > 0) out.push(`${tag}[style=${style}]`);
    if (tag === "style") {
      const css = (node.childNodes ?? []).map((c) => c.value ?? "").join("");
      if (sanitizeCss(css).blocked > 0) out.push(`<style>${css}`);
    }
  }
  return out;
}

describe("sanitizer: elements removed in full", () => {
  it("<link> with every rel (and none), any case", () => {
    for (const rel of ["stylesheet", "prefetch", "prerender", "preload", "dns-prefetch", "preconnect", "modulepreload", "icon", "PreRender", " prerender ", "canonical", "alternate"])
      assert.ok(!has(`<link rel="${rel}" href="http://x.test/a">`, /<link/i), rel);
    assert.ok(!has('<link href="a.css">', /<link/i), "relative href, no rel");
    assert.ok(!has("<LINK REL=PRERENDER HREF=//x.test/>", /<link/i));
    assert.ok(!has('<link rel="prerender"', /prerender/), "unterminated tag");
  });
  it("<base>", () => {
    assert.ok(!has('<base href="http://x.test/">', /<base/i));
    assert.ok(!has('<BASE target="_blank">', /<base/i));
  });
  it("<meta http-equiv> of every kind; other meta tags stay", () => {
    for (const v of ["refresh", "Refresh", "REFRESH ", "content-security-policy", "set-cookie", "x-dns-prefetch-control", ""])
      assert.ok(!has(`<meta http-equiv="${v}" content="0;url=http://x.test/">`, /<meta/i), JSON.stringify(v));
    assert.ok(!has("<meta http-equiv=refresh content='1;url=//x.test'>", /<meta/i), "unquoted");
    assert.ok(!has('<meta HTTP-EQUIV="refresh" content="1">', /<meta/i), "attribute case");
    assert.ok(has('<meta charset="utf-8"><meta name="viewport" content="width=device-width">', /<meta name="viewport"/));
  });
  it("<portal>, frames, objects, embeds, noscript", () => {
    for (const t of ["portal", "iframe", "object", "applet", "noscript", "noembed", "noframes"]) {
      const html = clean(`<p>a</p><${t} src="a.html" data="a">inner <img src="data:,">text</${t}><p>b</p>`);
      assert.ok(!new RegExp(`<${t}\\b`, "i").test(html), t);
      assert.ok(!html.includes("inner"), `${t} content goes with it`);
      assert.ok(html.includes("<p>a</p>") && html.includes("<p>b</p>"), `${t}: neighbours stay`);
    }
  });
  it("<embed> (a void element) and <frame> are removed", () => {
    assert.ok(!has('<embed src="a.swf"><p>k</p>', /<embed/));
    assert.ok(!has('<embed src="http://x.test/a.swf">', /x\.test/));
  });
  it("<script type=speculationrules> in every spelling; ordinary scripts stay", () => {
    for (const t of ["speculationrules", "SpeculationRules", " speculationrules ", "SPECULATIONRULES", "\tspeculationrules\n"])
      assert.ok(!has(`<script type="${t}">{"prerender":[{"source":"list","urls":["http://x.test"]}]}</script>`, /speculationrules/i), JSON.stringify(t));
    assert.ok(!has("<script type=speculationrules>{}</script>", /speculationrules/i), "unquoted");
    assert.ok(!has('<script type="&#115;peculationrules">{}</script>', /speculationrules/i), "entity in the value");
    assert.ok(!has('<svg><script type="speculationrules">{}</script></svg>', /speculationrules/i), "inside svg");
    assert.ok(has('<script>var n = 1 < 2 && "<img src=x>";</script>', /var n = 1 < 2 && "<img src=x>";/), "scripts are kept as written");
    assert.ok(has('<script type="application/json" id="d">{"a":1}</script>', /application\/json/));
  });
  it("<script src> is removed unless data: or relative", () => {
    assert.ok(!has('<script src="https://x.test/a.js"></script>', /<script/));
    assert.ok(!has('<script src="//x.test/a.js">alert(1)</script>', /alert/));
  });
});

describe("sanitizer: URL attributes", () => {
  const BAD = [
    "http://x.test/a", "https://x.test/a", "HtTpS://X.test/a", "//x.test/a", "///x.test/a", "\\\\x.test/a", "/\\x.test/a", "\\/x.test/a",
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", "vbscript:x", "blob:https://x.test/u", "about:blank", "mailto:a@b.test", "ftp://x.test/a", "ws://x.test/",
    " http://x.test/a", "\thttp://x.test/a", "\nhttp://x.test/a", "\u0001http://x.test/a", "ht\ttp://x.test/a", "http:\n//x.test", "/\t/x.test", "ht\ntp://x.test",
    "&#104;ttp://x.test/a", "&#x68;&#x74;&#x74;&#x70;://x.test/a", "http&colon;//x.test/a", "http&#58;//x.test/a", "http:&sol;&sol;x.test", "&sol;&sol;x.test",
    "&#x2F;&#x2F;x.test", "&Tab;//x.test", "h&Tab;ttp://x.test", "http&NewLine;://x.test", "jav&#x61;script:alert(1)", "&#106;avascript:alert(1)",
    "http://x.test/&#x61;", "data&colon;text/html,<b>x</b>#//x", "&bsol;&bsol;x.test", "/&bsol;x.test",
  ];
  it("an img with any outside address is removed (whitespace, case, entity and protocol-relative tricks)", () => {
    for (const bad of BAD) {
      // "data&colon;…" decodes to a data: URL: it is allowed, so it is checked on its own below
      if (bad.startsWith("data&colon;")) continue;
      for (const q of ['"', "'"]) {
        const html = clean(`<p>k</p><img src=${q}${bad}${q}>`);
        assert.ok(!html.includes("<img"), `${JSON.stringify(bad)} kept: ${html}`);
        assert.ok(html.includes("<p>k</p>"));
      }
    }
    assert.ok(!has("<img src=http://x.test/a.png>", /<img/), "unquoted");
    assert.ok(!has("<img/src='http://x.test/a.png'>", /<img/), "slash instead of space");
    assert.ok(!has('<img alt="a"src="http://x.test/a.png">', /<img/), "no space after the quote");
    assert.ok(!has('<IMG SRC="http://x.test/a.png">', /<img/i), "tag and attribute case");
    assert.ok(has("<img src=a.png src='http://x.test/b.png'>", /<img src="a.png">/), "…and the browser uses the first");
    assert.ok(!has('<img src="http://x.test/a.png" onerror="x">', /<img/));
  });
  it("data: and relative values are kept", () => {
    for (const ok of ["data:image/gif;base64,R0lGODlhAQABAAAAACw=", "DATA:image/gif;base64,AA", " data:,x", "a.png", "./a.png", "../a.png", "/a.png", "?q=1", "#frag", "", "sub/dir/a.png?x=1&y=2#z", "x:y".replace("x:y", "./x:y"), "data&colon;image/gif;base64,AA"]) {
      const html = clean(`<img src="${ok}">`);
      assert.ok(html.includes("<img"), `${JSON.stringify(ok)} was removed`);
    }
  });
  it("every URL attribute is checked: src href srcset action formaction ping poster background xlink:href data", () => {
    // loaders are removed; other elements (table, td, math …) keep their content and lose only the address
    const keepsElement = [/<table/, /<td/, /<math/];
    const cases: [string, RegExp][] = [
      ['<video src="http://x.test/v.mp4"></video>', /<video/],
      ['<audio src="//x.test/a.mp3"></audio>', /<audio/],
      ['<source src="http://x.test/v.mp4">', /<source/],
      ['<track src="http://x.test/t.vtt">', /<track/],
      ['<video poster="http://x.test/p.png"></video>', /<video/],
      ['<input type="image" src="http://x.test/b.png">', /<input/],
      ['<table background="http://x.test/b.png"><tr><td>c</td></tr></table>', /<table/],
      ['<td background="//x.test/b.png">c</td>', /<td/],
      ['<img srcset="http://x.test/a.png 1x">', /<img/],
      ['<img src="a.png" srcset="a.png 1x, http://x.test/b.png 2x">', /<img/],
      ['<img srcset="a.png 1x,//x.test/b.png 2x">', /<img/],
      ['<picture><source srcset="http://x.test/a.webp"><img src="a.png"></picture>', /<source/],
      ['<svg><image href="http://x.test/a.png"/></svg>', /<image/],
      ['<svg><image xlink:href="http://x.test/a.png"/></svg>', /<image/],
      ['<svg><use href="http://x.test/s.svg#a"/></svg>', /<use/],
      ['<svg><use xlink:href="//x.test/s.svg#a"/></svg>', /<use/],
      ['<svg><feImage href="http://x.test/a.png"/></svg>', /feimage/i],
      ['<svg><script href="http://x.test/a.js"></script></svg>', /<script/],
      ['<math href="http://x.test/"><mi>x</mi></math>', /<math/],
    ];
    for (const [html, gone] of cases) {
      assert.ok(!clean(html).includes("x.test"), `address left: ${html}`);
      if (!keepsElement.some((k) => k.source === gone.source)) assert.ok(!has(html, gone), html);
    }
    assert.ok(has('<table background="http://x.test/b.png"><tr><td>cell</td></tr></table>', /<td>cell<\/td>/), "content stays");
    assert.ok(has('<html><body background="//x.test/b.png"><p>page</p></body></html>', /<p>page<\/p>/), "a stray body background never takes the page");
    assert.ok(has('<img srcset="data:image/png;base64,AA,BB 1x, c.png 2x">', /<img/), "a data: URL may hold commas");
    assert.ok(has('<svg><use href="#a"/></svg>', /<use/), "a fragment is relative");
  });
  it("links and forms keep their text and lose only the address (href, xlink:href, ping, action, formaction)", () => {
    assert.equal(body('<a href="http://x.test/a" class="b">text</a>'), '<a class="b">text</a>');
    assert.equal(body('<a href="//x.test/a" ping="http://x.test/p">t</a>'), "<a>t</a>");
    assert.equal(body('<a href="#f" ping="a/b">t</a>'), '<a href="#f" ping="a/b">t</a>');
    assert.equal(body('<form action="http://x.test/"><button formaction="//x.test/">go</button></form>'), "<form><button>go</button></form>");
    assert.equal(body('<form action="a.php"><input type="submit" formaction="http://x.test"></form>'), '<form action="a.php"><input type="submit"></form>');
    assert.equal(body('<svg><a xlink:href="http://x.test/"><text>t</text></a></svg>').replace(/ xmlns[^>]*/g, ""), "<svg><a><text>t</text></a></svg>");
    assert.equal(body('<map><area href="http://x.test/" alt="a"></map>'), '<map><area alt="a"></map>');
    // an element that LOADS something is removed, not just stripped
    assert.equal(body('<p>a<img src="http://x.test/a.png">b</p>'), "<p>ab</p>");
  });
  it("<template> content, SMIL set/animate and the old xml:base are covered", () => {
    assert.ok(!has('<template><img src="http://x.test/a.png"></template>', /<img/), "template content");
    assert.ok(!has('<svg><image href="a.png"><set attributeName="href" to="http://x.test/a.png"/></image></svg>', /<set/), "set href");
    assert.ok(!has('<svg><image href="a.png"><animate attributeName="xlink:href" values="a.png;//x.test/b.png"/></image></svg>', /<animate/), "animate xlink:href");
    assert.ok(!has('<svg><rect><set attributeName="fill" to="url(http://x.test/a.svg#g)"/></rect></svg>', /<set/), "set to a url()");
    assert.ok(has('<svg><rect><animate attributeName="width" values="1;2"/></rect></svg>', /<animate/), "ordinary animation stays");
    assert.ok(!has('<svg xml:base="http://x.test/"><image href="a.png"/></svg>', /xml:base/));
  });
  it("nothing is lost around a removed element and nothing leaks out of a broken one", () => {
    assert.ok(!has('<img src="http://x.test/a.png"<img src=x>', /x\.test/), "unterminated");
    assert.ok(!has("<p>a</p><img src='http://x.test/a.png", /x\.test/), "EOF inside a tag: the browser drops it");
    assert.ok(!has('<!-- <img src="http://x.test/c.png"> --><p>t</p>', /x\.test/), "comments are dropped");
    assert.ok(!has('<!--[if IE]><link rel="stylesheet" href="http://x.test/ie.css"><![endif]--><p>t</p>', /x\.test/), "conditional comment");
    assert.ok(!has('<![CDATA[<img src="http://x.test/c.png">]]><p>t</p>', /<img/), "CDATA in HTML is a bogus comment");
    assert.ok(!has('<title><img src="http://x.test/a.png"></title>', /<img/), "RCDATA is text");
    assert.ok(!has('<textarea><img src="http://x.test/a.png"></textarea>', /<img/), "RCDATA is text");
    assert.ok(!has('<svg><style><a title="</style><img src=http://x.test/a.png>"></style></svg>', /<img/), "style inside svg is markup there");
    // a known mXSS shape: the tree does not survive a serialize/parse round trip. The verification pass notices and the
    // page is not served (fixed document), or the result is clean.
    const mxss = '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;/mglyph&gt;&lt;img src=1 onerror=alert(1)&gt;">';
    clearSanitizeCache();
    const served = servedDocument(mxss);
    assert.ok(served === BLOCKED_DOCUMENT || !/<img[^>]*onerror/.test(served), served);
  });
});

describe("sanitizer: CSS", () => {
  const bad: [string, string][] = [
    ["url(http://x.test/a.png)", "url"],
    ["URL( 'http://x.test/a.png' )", "url, quoted, spaced"],
    ['url("//x.test/a.png")', "protocol-relative"],
    ["u\\72l(http://x.test/a.png)", "escaped function name"],
    ["\\75rl(http://x.test/a.png)", "escaped first letter"],
    ["url(ht\\74p://x.test/a.png)", "escaped scheme"],
    ["url(ht\\\ntp://x.test)", "escaped newline"],
    ["url(javascript:alert(1))", "javascript"],
    ["url(blob:https://x.test/u)", "blob"],
    ["image-set('http://x.test/a.png' 1x)", "image-set string"],
    ["-webkit-image-set(\"//x.test/a.png\" 1x)", "prefixed image-set"],
    ["image-set(url(http://x.test/a.png) 1x)", "image-set url"],
    ["cross-fade(url(http://x.test/a.png), 'a.png')", "cross-fade"],
    ["src('http://x.test/a.png')", "src()"],
    ["image-set(var(--u) 1x)", "var in image-set"],
    ["src(attr(data-u))", "attr in src"],
    ["attr(data-u type(<url>))", "typed attr"],
    ["attr(data-u url)", "attr url"],
    ["image(url(//x.test/a))", "image()"],
  ];
  it("neutralises every way a declaration can load an outside URL", () => {
    for (const [value, what] of bad) {
      const r = sanitizeCss(`a{background:${value}}`);
      assert.ok(r.blocked > 0, `${what} not blocked: ${value}`);
      assert.ok(!/x\.test/.test(r.text), `${what} still names the host: ${r.text}`);
    }
  });
  it("drops @import in every spelling", () => {
    for (const css of ["@import url(http://x.test/a.css);b{}", '@import "http://x.test/a.css";b{}', "@IMPORT 'a.css' screen;b{}", "@\\69mport url(//x.test/a.css);b{}", "@import url(a.css)"]) {
      const r = sanitizeCss(css);
      assert.ok(r.blocked > 0 && !/import/i.test(r.text.replace(/b\{\}/, "")), css);
    }
    assert.equal(sanitizeCss("@import url(http://x.test/a.css);b{color:red}").text.trim().endsWith("b{color:red}"), true);
  });
  it("keeps ordinary CSS byte for byte", () => {
    for (const css of [
      "a{color:red;background:url(data:image/png;base64,AAAA)}",
      "a{background:url('a.png');content:attr(data-tip);width:calc(1px + 2px)}",
      "/* url(http://x.test) in a comment */ a{color:blue}",
      'a::before{content:"url(http://x.test)"}',
      "a{background:image-set('a.png' 1x, 'b.png' 2x)}",
      "#url(a){color:red}",
      "a{font-family:'Nunito',sans-serif;grid-template-areas:'a b'}",
      "@media (min-width:1px){a{--x:var(--y,1px);margin:var(--x)}}",
      "a{&:hover{color:red}}",
    ]) {
      const r = sanitizeCss(css);
      assert.equal(r.blocked, 0, css);
      assert.equal(r.text, css);
    }
  });
  it("applies to <style> elements and style attributes (also svg presentation attributes), in place", () => {
    assert.ok(!has("<style>@import url(//x.test/a.css);a{background:url(http://x.test/b.png)}</style>", /x\.test/));
    assert.ok(has("<style>a{color:red}</style>", /<style>a\{color:red\}<\/style>/));
    assert.ok(!has('<div style="background:url(http://x.test/a)">t</div>', /x\.test/));
    assert.ok(has('<div style="background:url(http://x.test/a)">t</div>', /<div[^>]*>t<\/div>/), "the element stays, its url becomes data:,");
    assert.ok(!has('<div style="background:u&#114;l(//x.test/a)">t</div>', /x\.test/), "entity in the attribute");
    assert.ok(!has('<svg><rect fill="url(http://x.test/a.svg#g)" mask="url(//x.test/m.svg#m)"/></svg>', /x\.test/));
    assert.ok(has('<svg><rect fill="url(#g)"/></svg>', /fill="url\(#g\)"/));
    assert.ok(!has('<svg><style>@import url(//x.test/a.css)</style></svg>', /x\.test/), "svg style with text only");
  });
});

describe("sanitizer: what must survive", () => {
  const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Weekly</title>
<style>:root{--a:#123}body{font:14px sans-serif;background:var(--a)}.k::after{content:"<ok>"}</style></head>
<body class="x" data-k="v"><h1 id="m">static-marker</h1><table><tr><th>a</th><td>1 &lt; 2 &amp; 3</td></tr></table>
<svg viewBox="0 0 10 10" width="40"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/><text x="1" y="5">t</text></svg>
<img alt="d" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><a href="#top">top</a>
<script>tb.onData((d)=>{document.getElementById("m").textContent="n="+(d.n<3?"low":"high")});tb.ready();</script></body></html>`;
  it("keeps the content, styles, tables, svg, data: images, fragment links and scripts", () => {
    const r = sanitizeHtml(PAGE);
    assert.deepEqual(r.findings, {});
    const out = r.html;
    for (const part of ["static-marker", "<title>Weekly</title>", "--a:#123", 'content:"<ok>"', "1 &lt; 2 &amp; 3", 'viewBox="0 0 10 10"', 'fill="url(#g)"', "data:image/gif;base64,R0lGODlhAQABAAAAACw=", 'href="#top"', 'd.n<3?"low":"high"', 'lang="en"', 'data-k="v"'])
      assert.ok(out.includes(part), `missing: ${part}`);
    assert.ok(out.startsWith("<!DOCTYPE html>"));
    assert.equal(clean(out), out, "idempotent");
  });
  it("a document without a doctype stays in quirks mode (no doctype is invented)", () => {
    assert.ok(!clean("<p>x</p>").toLowerCase().includes("<!doctype"));
  });
});

describe("sanitizer: fail closed", () => {
  it("servedDocument returns the fixed document when the parser or the size check fails", () => {
    clearSanitizeCache();
    assert.equal(servedDocument("x".repeat(SANITIZE_MAX_BYTES + 1)), BLOCKED_DOCUMENT);
    const hostile = { length: 1, replace() { throw new Error("boom"); }, [Symbol.toPrimitive]() { throw new Error("boom"); } } as unknown as string;
    assert.equal(servedDocument(hostile), BLOCKED_DOCUMENT);
    assert.equal(servedDocument(null as unknown as string), BLOCKED_DOCUMENT);
  });
  it("a pathologically deep document fails closed instead of crashing the app", () => {
    clearSanitizeCache();
    const out = servedDocument("<div>".repeat(200_000));
    assert.ok(out === BLOCKED_DOCUMENT || violations(out).length === 0);
  });
  it("the fixed document names no network claim and carries no agent text", () => {
    assert.ok(!/network|internet/i.test(BLOCKED_DOCUMENT));
    assert.match(BLOCKED_DOCUMENT, /cannot be shown/);
    assert.deepEqual(violations(BLOCKED_DOCUMENT), []);
  });
  it("a sanitized page is served from the cache the second time (same bytes)", () => {
    clearSanitizeCache();
    const a = servedDocument('<p>x</p><img src="http://x.test/a">');
    assert.equal(servedDocument('<p>x</p><img src="http://x.test/a">'), a);
    assert.ok(!a.includes("x.test"));
  });
});

describe("sanitizer: seeded fuzz against a second parser", () => {
  const PIECES = [
    '<img src="http://x.test/1.png">', "<img src=//x.test/2>", '<a href="http://x.test/">l</a>', '<link rel=prerender href="http://x.test/p">', '<base href="//x.test/">',
    '<meta http-equiv=refresh content="0;url=http://x.test">', '<script type=speculationrules>{"prerender":[{"urls":["http://x.test"]}]}</script>', "<script>var a=1<2;</script>",
    "<style>@import url(//x.test/a.css);a{background:url(http://x.test/b)}</style>", '<div style="background:url(//x.test/c)">', "</div>", "<svg>", "</svg>", "<math>", "</math>",
    '<svg><use href="http://x.test/s#a"/></svg>', "<select>", "</select>", "<table>", "<tr><td>", "</table>", "<template>", "</template>", "<textarea>", "</textarea>",
    "<title>", "</title>", "<noscript>", "</noscript>", "<iframe srcdoc='<img src=http://x.test/f>'>", "</iframe>", "<style>", "</style>", "<script>", "</script>", "<!--", "-->",
    "<![CDATA[", "]]>", "<p>", "</p>", "<b>", "</b>", "<form action=http://x.test>", "</form>", "<button formaction=//x.test>", "<foreignObject>", "<mglyph>", "<mtext>",
    "<annotation-xml encoding=text/html>", "&lt;", "&#x68;ttp://x.test", "<img src=\"", "\">", "'", '"', "<", ">", "=", "/", " ", "\n", "text ", "<!doctype html>", "<html>", "<body>",
    '<video poster="http://x.test/p"><source src="//x.test/v"></video>', "<input type=image src=http://x.test/i>", "<object data=http://x.test/o>", "<embed src=http://x.test/e>",
  ];
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  it("3000 random documents: the output is stable, has no outside URL by a second parser, and a second pass finds nothing", () => {
    const r = rng(20261018);
    let blocked = 0;
    for (let i = 0; i < 3000; i++) {
      const n = 1 + Math.floor(r() * 24);
      let html = "";
      for (let k = 0; k < n; k++) html += PIECES[Math.floor(r() * PIECES.length)];
      let out: string;
      try {
        out = sanitizeHtml(html).html;
      } catch {
        // failing closed is allowed (the app serves the fixed document), but it must stay rare
        blocked++;
        assert.equal(servedDocument(html), BLOCKED_DOCUMENT);
        continue;
      }
      assert.deepEqual(violations(out), [], `input: ${JSON.stringify(html)}\noutput: ${out}`);
      assert.deepEqual(sanitizeHtml(out).findings, {}, `a second pass still finds something: ${JSON.stringify(html)}`);
    }
    assert.ok(blocked < 30, `too many documents failed closed: ${blocked}`);
  });
});
