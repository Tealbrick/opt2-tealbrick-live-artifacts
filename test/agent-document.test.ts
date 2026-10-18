// Agent documents through the SDK sanitizer (C238, S8): the Live Artifacts corpus (the cases of the app's own S6/S7 sanitizer,
// kept as corpus cases against `sanitizeAgentDocument`), the S6/S7 re-check bypass shapes as fast refusals, what Live Artifacts
// needs to survive, fail-closed, the two renders, the data budget and a seeded fuzz run checked by an independent oracle.
// A case the SDK does not cover goes to the contracts lead (SANITIZE-AGENT-DOCUMENT.md), not into an app rule.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeAgentDocument } from "@opt2-tealbrick/miniapp-sdk";
import { parse } from "parse5";
import {
  ASSET_PREFIX,
  BIND_CUT_MARKER,
  BIND_MAX_TOTAL_BYTES,
  BLOCKED_DOCUMENT,
  bindData,
  clearSanitizeCache,
  escapedTextBytes,
  maxOutputLength,
  PARSE_MAX_ELEMENTS,
  sanitizeForStore,
  sanitizeHtml,
  servedDocument,
  servedDocumentInfo,
} from "../src/agent-document.ts";
import { injectHelper } from "../src/viewer-assets.ts";

const MARKER = "<!-- tb:sanitized v1 -->";
/** Timing ceilings are for the dev Mac running one file; PERF_BUDGET_SCALE widens them for a loaded parallel run (as in perf.test.ts). */
const SCALE = Number(process.env.PERF_BUDGET_SCALE ?? 1);
const clean = (html: string): string => sanitizeHtml(html).html;
const has = (html: string, re: RegExp): boolean => re.test(clean(html));

/** Oracle, written apart from the SDK: parse the OUTPUT as a browser would and list anything that could reach the network by
 *  static markup. A URL attribute may hold only a fragment, a raster `data:` image, or a path under ASSET_PREFIX. Every host in
 *  this file is `*.test`, so no attribute of the output may name one, and no CSS may load anything. */
const URL_ATTRS = ["src", "href", "xlink:href", "srcset", "action", "formaction", "ping", "poster", "background", "data", "cite", "srcdoc", "archive", "usemap", "classid", "codebase", "longdesc", "lowsrc"];
const urlOk = (v: string): boolean => {
  const s = v.replace(/[\t\n\r]/g, "").trim();
  return s === "" || s.startsWith("#") || s.startsWith(ASSET_PREFIX) || /^data:image\/(png|gif|jpeg|webp|avif|bmp);base64,/i.test(s);
};
/** CSS that can load something: @import, or url()/image-set()/src()/image()/cross-fade() other than a fragment (CSS escapes
 *  and comments removed first, so `u\\72l(` and `ur/**\/l(` count too). */
const cssLoads = (css: string): boolean => {
  const s = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\\([0-9a-f]{1,6})\s?/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16))).replace(/\\/g, "");
  return /@import/i.test(s) || /(?:url|image-set|src|image|cross-fade)\s*\(\s*(?!['"]?#)/i.test(s);
};
interface P5Node {
  nodeName: string;
  tagName?: string;
  attrs?: { name: string; value: string; prefix?: string }[];
  childNodes?: P5Node[];
  content?: P5Node;
  value?: string;
}
/** Script elements and inline handlers in the parsed tree (a `<script` inside a comment or text is not one). */
function scriptsIn(html: string): number {
  let n = 0;
  const todo: P5Node[] = [parse(html, { scriptingEnabled: true }) as unknown as P5Node];
  while (todo.length > 0) {
    const node = todo.pop() as P5Node;
    todo.push(...(node.childNodes ?? []));
    if (node.content) todo.push(node.content);
    if (node.tagName?.toLowerCase() === "script") n++;
    n += (node.attrs ?? []).filter((a) => /^on/i.test(a.name)).length;
  }
  return n;
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
    if (["link", "base", "portal", "iframe", "frame", "object", "embed", "form", "noscript", "fencedframe"].includes(tag)) out.push(`<${tag}>`);
    if (tag === "meta" && attr("http-equiv") !== null) out.push("meta http-equiv");
    // script TEXT is not checked: what a script does is the recorded residual R3; the rule types that make the browser fetch are
    if (tag === "script" && ["speculationrules", "importmap"].includes((attr("type") ?? "").trim().toLowerCase())) out.push((attr("type") ?? "").trim());
    for (const a of URL_ATTRS) {
      const v = attr(a);
      if (v !== null && !urlOk(v)) out.push(`${tag}[${a}=${v}]`);
    }
    for (const a of node.attrs ?? []) if (/\.test\b/i.test(a.value)) out.push(`${tag}[${a.name}] names a host`);
    const text = (node.childNodes ?? []).map((c) => c.value ?? "").join("");
    if (tag === "style" && cssLoads(text)) out.push(`<style> loads: ${text}`);
    if (cssLoads(attr("style") ?? "")) out.push(`style= loads: ${attr("style")}`);
  }
  return out;
}
const safe = (input: string, what = input): void => {
  const out = clean(input);
  assert.deepEqual(violations(out), [], `${what}\n=> ${out}`);
};

describe("corpus: elements removed in full (former LA cases)", () => {
  it("<link> with every rel (and none), any case", () => {
    for (const rel of ["stylesheet", "prefetch", "prerender", "preload", "dns-prefetch", "preconnect", "modulepreload", "icon", "PreRender", " prerender ", "canonical", "alternate"])
      assert.ok(!has(`<link rel="${rel}" href="http://x.test/a">`, /<link/i), rel);
    assert.ok(!has('<link href="a.css">', /<link/i), "relative href, no rel");
    assert.ok(!has("<LINK REL=PRERENDER HREF=//x.test/>", /<link/i));
    assert.ok(!has('<link rel="prerender"', /prerender/), "unterminated tag");
  });
  it("<base>, <meta http-equiv> of every kind (other meta tags stay)", () => {
    assert.ok(!has('<base href="http://x.test/">', /<base/i));
    assert.ok(!has('<BASE target="_blank">', /<base/i));
    for (const v of ["refresh", "Refresh", "REFRESH ", "content-security-policy", "set-cookie", "x-dns-prefetch-control", ""])
      assert.ok(!has(`<meta http-equiv="${v}" content="0;url=http://x.test/">`, /<meta/i), JSON.stringify(v));
    assert.ok(!has("<meta http-equiv=refresh content='1;url=//x.test'>", /<meta/i), "unquoted");
    assert.ok(!has('<meta HTTP-EQUIV="refresh" content="1">', /<meta/i), "attribute case");
    assert.ok(has('<meta charset="utf-8"><meta name="viewport" content="width=device-width">', /<meta name="viewport"/));
  });
  it("<portal>, frames, objects, embeds, noscript, fencedframe and forms; neighbours stay", () => {
    for (const t of ["portal", "iframe", "object", "applet", "noscript", "noembed", "noframes", "fencedframe", "form"]) {
      const html = clean(`<p>a</p><${t} src="a.html" data="a" action="http://x.test/">inner <img src="data:,">text</${t}><p>b</p>`);
      assert.ok(!new RegExp(`<${t}\\b`, "i").test(html), t);
      assert.ok(html.includes("<p>a</p>") && html.includes("<p>b</p>"), `${t}: neighbours stay`);
      assert.deepEqual(violations(html), [], t);
    }
    assert.ok(!has('<embed src="http://x.test/a.swf"><p>k</p>', /<embed|x\.test/));
  });
  it("<script type=speculationrules> in every spelling; ordinary scripts stay as written", () => {
    for (const t of ["speculationrules", "SpeculationRules", " speculationrules ", "SPECULATIONRULES", "\tspeculationrules\n"])
      assert.ok(!has(`<script type="${t}">{"prerender":[{"source":"list","urls":["http://x.test"]}]}</script>`, /speculationrules|x\.test/i), JSON.stringify(t));
    assert.ok(!has("<script type=speculationrules>{}</script>", /speculationrules/i), "unquoted");
    assert.ok(!has('<script type="&#115;peculationrules">{}</script>', /speculationrules/i), "entity in the value");
    assert.ok(!has('<svg><script type="speculationrules">{}</script></svg>', /speculationrules/i), "inside svg");
    assert.ok(!has('<script type="importmap">{"imports":{"a":"http://x.test/a.js"}}</script>', /importmap|x\.test/i), "import maps");
    assert.ok(has('<script>var n = 1 < 2 && "<img src=x>";</script>', /var n = 1 < 2 && "<img src=x>";/), "scripts are kept as written");
    assert.ok(has('<script type="application/json" id="d">{"a":1}</script>', /application\/json/));
  });
  it("<script src> outside the asset path is removed", () => {
    for (const html of ['<script src="https://x.test/a.js"></script>', '<script src="//x.test/a.js">alert(1)</script>', '<svg><script href="http://x.test/a.js"></script></svg>']) safe(html);
  });
});

describe("corpus: URL attributes (former LA cases; the SDK keeps only fragments, raster data: images and the asset path)", () => {
  const BAD = [
    "http://x.test/a", "https://x.test/a", "HtTpS://X.test/a", "//x.test/a", "///x.test/a", "\\\\x.test/a", "/\\x.test/a", "\\/x.test/a",
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", "vbscript:x", "blob:https://x.test/u", "about:blank", "mailto:a@b.test", "ftp://x.test/a", "ws://x.test/",
    " http://x.test/a", "\thttp://x.test/a", "\nhttp://x.test/a", "\u0001http://x.test/a", "ht\ttp://x.test/a", "http:\n//x.test", "/\t/x.test", "ht\ntp://x.test",
    "&#104;ttp://x.test/a", "&#x68;&#x74;&#x74;&#x70;://x.test/a", "http&colon;//x.test/a", "http&#58;//x.test/a", "http:&sol;&sol;x.test", "&sol;&sol;x.test",
    "&#x2F;&#x2F;x.test", "&Tab;//x.test", "h&Tab;ttp://x.test", "http&NewLine;://x.test", "jav&#x61;script:alert(1)", "&#106;avascript:alert(1)",
    "http://x.test/&#x61;", "data&colon;text/html,<b>x</b>#//x.test", "&bsol;&bsol;x.test", "/&bsol;x.test", "a.png", "../a.png", "/a.png",
    "/v/live-artifacts/_s/../../x.test", "data:image/svg+xml,<svg/>", "data:text/html,x",
  ];
  it("an img with any other address keeps no address (whitespace, case, entity, protocol-relative and path tricks)", () => {
    for (const bad of BAD)
      for (const q of ['"', "'"]) {
        const html = clean(`<p>k</p><img src=${q}${bad}${q}>`);
        assert.deepEqual(violations(html), [], `${JSON.stringify(bad)}: ${html}`);
        assert.ok(html.includes("<p>k</p>"));
      }
    for (const html of ["<img src=http://x.test/a.png>", "<img/src='http://x.test/a.png'>", '<img alt="a"src="http://x.test/a.png">', '<IMG SRC="http://x.test/a.png">', '<img src="http://x.test/a.png" onerror="x">'])
      safe(html);
  });
  it("fragments, raster data: images and the app's asset path are kept", () => {
    assert.ok(has('<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">', /src="data:image\/gif;base64,R0lGODlhAQABAAAAACw="/));
    assert.ok(has(`<img src="${ASSET_PREFIX}x.png">`, new RegExp(`src="${ASSET_PREFIX}x.png"`)));
    assert.ok(has('<a href="#top">t</a>', /href="#top"/));
    assert.ok(has('<svg><use href="#a"/></svg>', /<use href="#a"/));
  });
  it("every URL attribute is checked: src href srcset action formaction ping poster background xlink:href data cite usemap srcdoc", () => {
    for (const html of [
      '<video src="http://x.test/v.mp4"></video>', '<audio src="//x.test/a.mp3"></audio>', '<source src="http://x.test/v.mp4">', '<track src="http://x.test/t.vtt">',
      '<video poster="http://x.test/p.png"></video>', '<input type="image" src="http://x.test/b.png">', '<table background="http://x.test/b.png"><tr><td>c</td></tr></table>',
      '<td background="//x.test/b.png">c</td>', '<img srcset="http://x.test/a.png 1x">', '<img src="data:image/png;base64,AA" srcset="a.png 1x, http://x.test/b.png 2x">',
      '<picture><source srcset="http://x.test/a.webp"><img src="a.png"></picture>', '<svg><image href="http://x.test/a.png"/></svg>', '<svg><image xlink:href="http://x.test/a.png"/></svg>',
      '<svg><use href="http://x.test/s.svg#a"/></svg>', '<svg><use xlink:href="//x.test/s.svg#a"/></svg>', '<svg><feImage href="http://x.test/a.png"/></svg>',
      '<math href="http://x.test/"><mi>x</mi></math>', '<a href="//x.test/a" ping="http://x.test/p">t</a>', '<map><area href="http://x.test/" alt="a"></map>',
      '<svg><a xlink:href="http://x.test/"><text>t</text></a></svg>', '<button formaction="//x.test/">go</button>',
      ...["archive", "cite", "usemap", "classid", "srcdoc"].map((a) => `<div ${a}="http://x.test/a">t</div><blockquote ${a}="//x.test/b">q</blockquote>`),
    ])
      safe(html);
    assert.ok(has('<table background="http://x.test/b.png"><tr><td>cell</td></tr></table>', /<td>cell<\/td>/), "content stays");
    assert.ok(has('<html><body background="//x.test/b.png"><p>page</p></body></html>', /<p>page<\/p>/), "a stray body background never takes the page");
    assert.ok(has('<a href="http://x.test/a" class="b">text</a>', /<a[^>]*>text<\/a>/), "a link keeps its text");
  });
  it("<template> content, SMIL set/animate and xml:base are covered", () => {
    for (const html of [
      '<template><img src="http://x.test/a.png"></template>',
      '<svg><image href="#a"><set attributeName="href" to="http://x.test/a.png"/></image></svg>',
      '<svg><image href="#a"><animate attributeName="xlink:href" values="#a;//x.test/b.png"/></image></svg>',
      '<svg><rect><set attributeName="fill" to="url(http://x.test/a.svg#g)"/></rect></svg>',
      '<svg xml:base="http://x.test/"><image href="#a"/></svg>',
    ])
      safe(html);
    assert.ok(has('<svg><rect><animate attributeName="width" values="1;2"/></rect></svg>', /<animate/), "ordinary animation stays");
  });
  it("nothing leaks out of a broken tag, a comment, CDATA, RCDATA or foreign content (mXSS shape: refused or clean)", () => {
    for (const html of [
      '<img src="http://x.test/a.png"<img src=x>', "<p>a</p><img src='http://x.test/a.png", '<![CDATA[<img src="http://x.test/c.png">]]><p>t</p>',
      '<title><img src="http://x.test/a.png"></title>', '<textarea><img src="http://x.test/a.png"></textarea>', '<svg><style><a title="</style><img src=http://x.test/a.png>"></style></svg>',
      '<!--[if IE]><link rel="stylesheet" href="http://x.test/ie.css"><![endif]--><p>t</p>',
    ])
      safe(html);
    const mxss = '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;/mglyph&gt;&lt;img src=1 onerror=alert(1)&gt;">';
    clearSanitizeCache();
    const served = servedDocument(mxss);
    assert.ok(served === BLOCKED_DOCUMENT || violations(served).length === 0, served);
  });
});

describe("corpus: CSS (former LA cases)", () => {
  const bad = [
    "url(http://x.test/a.png)", "URL( 'http://x.test/a.png' )", 'url("//x.test/a.png")', "u\\72l(http://x.test/a.png)", "\\75rl(http://x.test/a.png)",
    "url(ht\\74p://x.test/a.png)", "url(ht\\\ntp://x.test)", "url(javascript:alert(1))", "url(blob:https://x.test/u)", "image-set('http://x.test/a.png' 1x)",
    '-webkit-image-set("//x.test/a.png" 1x)', "-moz-image-set('http://x.test/a.png' 1x)", "image-set(url(http://x.test/a.png) 1x)", "cross-fade(url(http://x.test/a.png), 'a.png')",
    "src('http://x.test/a.png')", "image(url(//x.test/a))",
  ];
  it("no declaration in a <style> or a style attribute keeps an outside URL", () => {
    for (const v of bad) {
      safe(`<style>a{background:${v}}</style>`, `<style> ${v}`);
      safe(`<div style="background:${v.replace(/"/g, "'")}">t</div>`, `style= ${v}`);
    }
  });
  it("@import in every spelling, and CR/FF/LF inside a string cannot hide what follows", () => {
    for (const css of ["@import url(http://x.test/a.css);b{}", '@import "http://x.test/a.css";b{}', "@IMPORT 'a.css' screen;b{}", "@\\69mport url(//x.test/a.css);b{}", "@import url(a.css)"])
      safe(`<style>${css}</style>`, css);
    for (const nl of ["\u000c", "\r", "\n", "\r\n"]) {
      safe(`<div style="content:'x${nl};background:url(//evil.test/a)'">t</div>`, `attribute ${JSON.stringify(nl)}`);
      safe(`<style>a{content:'x${nl};background:url(//evil.test/a)'}</style>`, `style ${JSON.stringify(nl)}`);
      safe(`<style>@media x{a{content:'x${nl}'}}@import url(//evil.test/b.css);</style>`, `import ${JSON.stringify(nl)}`);
    }
  });
  it("ordinary CSS stays (colours, calc, custom properties, media queries, nesting, svg fragment paint)", () => {
    for (const css of ["a{color:red;width:calc(1px + 2px)}", "@media (min-width:1px){a{--x:var(--y,1px);margin:var(--x)}}", "a{font-family:'Nunito',sans-serif;grid-template-areas:'a b'}"])
      assert.ok(clean(`<style>${css}</style>`).includes(css), css);
    assert.ok(has('<div style="color:red">t</div>', /style="color:red;?"/));
    assert.ok(has('<svg><rect fill="url(#g)"/></svg>', /fill="url\(#g\)"/));
  });
});

describe("S6/S7 re-check bypass shapes: refused fast, before any parse", () => {
  const N = 40_000;
  const ATTRS = Array.from({ length: 36_000 }, (_, i) => `a${i}`).join(" ");
  const shapes: [string, string][] = [
    ["180 KB tag with 36,000 attributes", `<a ${ATTRS}>x</a>`],
    ["svg with 38,000 attributes", `<svg ${Array.from({ length: 38_000 }, (_, i) => `d${i}="1"`).join(" ")}></svg>`],
    ["attributes behind quoted > characters", `<a ${Array.from({ length: 20_000 }, (_, i) => `a${i}=">"`).join(" ")}>x</a>`],
    ["an end tag with many attributes", `</a ${ATTRS}>`],
    ["300,000 tags", "<b>".repeat(300_000)],
    // the S7 re-check (the app's own precheck was bypassed by these): runs of tag starts inside one tag, and '<' in quoted values
    ["div <a <a … x40,000", `<div ${"<a ".repeat(N)}>x</div>`],
    ["div <a <b … x20,000 pairs", `<div ${"<a <b ".repeat(N / 2)}>x</div>`],
    ['a x0="<b" … x40,000', `<a ${Array.from({ length: N }, (_, i) => `x${i}="<b"`).join(" ")}>x</a>`],
    ["a x0='<b' … x40,000", `<a ${Array.from({ length: N }, (_, i) => `x${i}='<b'`).join(" ")}>x</a>`],
    // the S6 re-check: contexts the scan must not honour
    ["after the comment closer <!-->", `<!--><a ${ATTRS}>x</a>`],
    ["after the comment closer <!--->", `<!---><a ${ATTRS}>x</a>`],
    ["after a bang comment end --!>", `<!-- x --!><a ${ATTRS}>x</a>`],
    ["inside a style in an svg", `<svg><style><a ${ATTRS}></a></style></svg>`],
    ["inside a title in an svg", `<svg><title><a ${ATTRS}></a></title></svg>`],
    ["inside a script in a math", `<math><script><a ${ATTRS}></a></script></math>`],
    ["inside a plain style", `<style><a ${ATTRS}></a></style>`],
    ["inside a textarea", `<textarea><a ${ATTRS}></a></textarea>`],
    ["behind an unbalanced quote in a comment", `<!-- <p x=' --><a ${ATTRS}>'>`],
    ["behind an unbalanced quote in a script", `<script>var a = "<p x='";</script><a ${ATTRS}>'>`],
    ["a quote that never closes", `<a x='" ><b ${ATTRS}>`],
    ["behind an unquoted value", `<a x=1<b ${ATTRS}>`],
    ["a tag inside a quoted value", `<a title="<b ${ATTRS}>">`],
  ];
  for (const [what, html] of shapes)
    it(what, () => {
      clearSanitizeCache();
      // best of three: a load spike on a shared runner passes on a later try; a real regression (seconds of parse) never does
      let ms = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3 && ms >= 100 * SCALE; i++) {
        clearSanitizeCache();
        const t = performance.now();
        assert.throws(() => sanitizeHtml(html), what);
        assert.throws(() => sanitizeForStore(html), "refused at write time (store.ts answers view_not_servable)");
        assert.equal(servedDocument(html), BLOCKED_DOCUMENT, what);
        ms = Math.min(ms, performance.now() - t);
      }
      assert.ok(ms < 100 * SCALE, `${what} took ${ms.toFixed(0)} ms (ceiling ${100 * SCALE} ms)`);
    });
  it("the limit itself is fine: 256 attributes on one tag", () => {
    assert.doesNotThrow(() => sanitizeHtml(`<a ${Array.from({ length: 256 }, (_, i) => `a${i}`).join(" ")}>x</a>`));
  });
  it("a plain script with `i<n` and a short body is not refused", () => {
    assert.doesNotThrow(() => sanitizeHtml("<!doctype html><body><script>for(i=0;i<n;i++){ total += rows[i].v; } tb.ready();</script></body>"));
    assert.doesNotThrow(() => sanitizeHtml("<script>for(i=0;i<n;i++){ if(a>b) go(); } var s='a<b';</script>"));
  });
  // Known SDK false refusals (miniapp-sdk 0.1.31): a '<' + letter starts a candidate tag, so 257+ tokens after it before the next
  // '>' count as attributes. Fail closed, but a benign page is refused. The contracts lead fixes it in miniapp-sdk 0.1.33; then
  // remove the skips (they are the regression tests).
  const SKIP = "SDK 0.1.31 false refusal (`<`+letter then 257+ tokens); fixed by the contracts lead in miniapp-sdk 0.1.33";
  it("a script with `i<n` and a long loop body is not refused", { skip: SKIP }, () => {
    assert.doesNotThrow(() => sanitizeHtml(`<!doctype html><body><script>function f(n){for(var i=0;i<n;i++){ ${"a = b + c; ".repeat(100)} } }</script></body>`));
  });
  it("prose with `a<b` and 400 words after it is not refused", { skip: SKIP }, () => {
    assert.doesNotThrow(() => sanitizeHtml(`<!doctype html><body><p>1 < 2 and a<b and ${"word ".repeat(400)}</p></body>`));
  });
  it("a style comment with `a<b` and a long body is not refused", { skip: SKIP }, () => {
    assert.doesNotThrow(() => sanitizeHtml(`<!doctype html><style>/* a<b ${"x ".repeat(400)}*/ p{color:red}</style><body>x</body>`));
  });
});

describe("S8 parse DoS shapes (sdk 0.1.31 passes them): refused DURING the parse by the bounded seam", () => {
  const attrs = (n: number, p = "a"): string => Array.from({ length: n }, (_, i) => `${p}${i}`).join(" ");
  const FORMATTING = "<b><i><u><s><em><strong><code><small>";
  // [shape, ceiling in ms for the three calls below]. The three shapes of the S8 re-check are refused within 100 ms in all.
  // The element-cap shape costs what creating PARSE_MAX_ELEMENTS elements costs: ~100 ms per call on the dev Mac (3 s and 4 MB
  // of output unbounded). That IS the bound (the same cap as sdk 0.1.33), so its ceiling is 250 ms per call: room for a loaded
  // shared machine, and still more than 10× under the unbounded cost, so a lost bound fails this test.
  const shapes: [string, string, number][] = [
    // adoptAttributes merges every new attribute into the root element, and parse5 rebuilds a name set per call: quadratic
    ["<html z0><html z1>… x30,000 (370 KB, 26 s unbounded)", Array.from({ length: 30_000 }, (_, i) => `<html z${i}>`).join(""), 100],
    ["<body z0><body z1>… x30,000 (29 s unbounded)", Array.from({ length: 30_000 }, (_, i) => `<body z${i}>`).join(""), 100],
    // every <p> re-opens the <b> with its 256 attributes (79 KB gave 39 MB of output in 15 s)
    ["<p><b a0..a255> + <p>x x20,000", `<p><b ${attrs(256)}>${"<p>x".repeat(20_000)}`, 100],
    // eight formatting elements re-opened per <p>: elements the source does not count
    ["<p>+8 formatting elements + <p>x x45,000 (over the element cap)", `<p>${FORMATTING}${"<p>x".repeat(45_000)}`, 3 * 250],
  ];
  for (const [what, html, ceiling] of shapes)
    it(what, () => {
      let ms = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3 && ms >= ceiling * SCALE; i++) {
        clearSanitizeCache();
        const t = performance.now();
        assert.throws(() => sanitizeHtml(html), what);
        assert.throws(() => sanitizeForStore(html), "refused at write time (store.ts answers view_not_servable)");
        assert.equal(servedDocument(html), BLOCKED_DOCUMENT, what);
        ms = Math.min(ms, performance.now() - t);
      }
      assert.ok(ms < ceiling * SCALE, `${what} took ${ms.toFixed(0)} ms (ceiling ${ceiling * SCALE} ms)`);
    });
  // fire-on-bad: small versions of the shapes that the plain SDK 0.1.31 accepts, so the refusal is the seam's own
  it("the seam, not the SDK, refuses them (small versions pass the plain SDK)", () => {
    const small = [Array.from({ length: 3_000 }, (_, i) => `<html z${i}>`).join(""), `<p><b ${attrs(256)}>${"<p>x".repeat(100)}`];
    for (const html of small) {
      assert.equal(sanitizeAgentDocument(html, { allowScripts: true, assetPrefix: ASSET_PREFIX }).ok, true, "the plain SDK accepts it");
      assert.throws(() => sanitizeHtml(html), "the seam refuses it");
    }
  });
  it("element cap: twice the SDK tag cap", () => {
    assert.equal(PARSE_MAX_ELEMENTS, 200_000);
  });
  it("output cap: max(4 × input, input + 1 MiB); a page under the element cap that grows past it is refused", () => {
    assert.equal(maxOutputLength(10), 10 + 1024 * 1024);
    assert.equal(maxOutputLength(1_000_000), 4_000_000);
    const html = `<p>${FORMATTING}${"<p>x".repeat(20_000)}`; // ~180,000 elements: under PARSE_MAX_ELEMENTS
    const plain = sanitizeAgentDocument(html, { allowScripts: true, assetPrefix: ASSET_PREFIX });
    assert.equal(plain.ok, true, "the plain SDK accepts it");
    assert.ok(plain.html.length > maxOutputLength(html.length), `output ${plain.html.length} for input ${html.length}`);
    assert.throws(() => sanitizeHtml(html), "the output cap refuses it");
  });
  // quiet-on-good
  it("ordinary <html>/<body> attributes, repeated root tags and normal mis-nested formatting are kept", () => {
    const page = `<!doctype html><html lang="en" data-theme="dark"><head><title>t</title></head><body class="x"><body id="y"><p><b>bold<i>both</p><p>again</b></i> after</p><p><b ${attrs(40)}>x${"<p>y".repeat(50)}</body></html>`;
    const out = sanitizeHtml(page).html;
    assert.match(out, /<html lang="en" data-theme="dark">/);
    assert.match(out, /<body class="x" id="y">/);
    assert.ok(out.includes("again"));
  });
  it("a 900-row table with attributes on every cell is kept", () => {
    const rows = Array.from({ length: 900 }, (_, r) => `<tr>${Array.from({ length: 6 }, (_, c) => `<td class="c${c}" data-r="${r}" title="v">${r * c}</td>`).join("")}</tr>`).join("");
    assert.doesNotThrow(() => sanitizeHtml(`<!doctype html><table>${rows}</table>`));
  });
});

describe("what Live Artifacts needs to survive", () => {
  const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Weekly</title>
<style>:root{--a:#123}body{font:14px sans-serif;background:var(--a)}.k::after{content:"<ok>"}</style></head>
<body class="x" data-k="v"><h1 id="m">static-marker</h1><table><tr><th>a</th><td>1 &lt; 2 &amp; 3</td></tr></table>
<svg viewBox="0 0 10 10" width="40"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/><text x="1" y="5">t</text></svg>
<img alt="d" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><a href="#top">top</a><p data-tb-text="n.total">?</p>
<script>tb.onData((d)=>{document.getElementById("m").textContent="n="+(d.n<3?"low":"high")});tb.ready();</script></body></html>`;
  it("content, styles, tables, svg, data: images, fragment links, text slots and scripts; nothing removed; a fixed point", () => {
    const r = sanitizeAgentDocument(PAGE, { allowScripts: true, assetPrefix: ASSET_PREFIX });
    assert.equal(r.ok, true);
    assert.deepEqual(r.removed, []);
    for (const part of ["static-marker", "<title>Weekly</title>", "--a:#123", 'content:"<ok>"', "1 &lt; 2 &amp; 3", 'viewBox="0 0 10 10"', 'fill="url(#g)"', "data:image/gif;base64,R0lGODlhAQABAAAAACw=", 'href="#top"', 'data-tb-text="n.total"', 'd.n<3?"low":"high"', 'lang="en"', 'data-k="v"'])
      assert.ok(r.html.includes(part), `missing: ${part}`);
    assert.ok(r.html.startsWith(`${MARKER}<!DOCTYPE html>`));
    assert.equal(clean(r.html), r.html, "idempotent");
  });
  it("a document without a doctype stays in quirks mode (no doctype is invented)", () => {
    assert.ok(!clean("<p>x</p>").toLowerCase().includes("<!doctype"));
  });
  it("the tb helper goes after the marker and the doctype (a script before the doctype would switch to quirks mode)", () => {
    const withDoctype = injectHelper(clean("<!doctype html><p>x</p>"));
    assert.ok(withDoctype.startsWith(`${MARKER}<!DOCTYPE html><script>`), withDoctype.slice(0, 80));
    const without = injectHelper(clean("<p>x</p>"));
    assert.ok(without.startsWith(`${MARKER}<script>`), without.slice(0, 80));
  });
});

describe("two renders: scripts allowed, and the scriptless render (C239)", () => {
  it("runsScripts is read from the sanitized page: a script of any type (JSON too) or an inline handler", () => {
    for (const html of ["<script>x()</script>", '<p onclick="x()">t</p>', '<script type="application/json">{"a":1}</script>', "<svg><script>x()</script></svg>"])
      assert.equal(servedDocumentInfo(html).runsScripts, true, html);
    for (const html of ["<p>t</p>", "<p>onclick=x()</p>"]) assert.equal(servedDocumentInfo(html).runsScripts, false, html);
    // an outside script loses its src but stays as an (empty) element: still counted as a script (the safe side)
    assert.equal(servedDocumentInfo('<script src="https://x.test/a.js"></script>').runsScripts, true);
  });
  it("the scriptless render has no script and no handler, and says what the page had", () => {
    const html = '<p onclick="go()" onmouseover="go()">x</p><script>tb.ready()</script><svg onload="go()"><script>go()</script></svg>';
    const plain = servedDocumentInfo(html, { allowScripts: false });
    assert.equal(plain.runsScripts, true);
    assert.equal(scriptsIn(plain.html), 0, plain.html);
    assert.ok(plain.html.includes(">x</p>"));
    const stored = sanitizeForStore(html);
    assert.equal(stored.runsScripts, true);
    assert.equal(stored.plain?.toString("utf8"), plain.html);
    assert.equal(sanitizeForStore("<p>t</p>").plain, null, "a page without scripts stores no second variant");
  });
});

describe("data inlined into a scriptless page: the cap counts SERVED (escaped) bytes", () => {
  const slots = (n: number, key = "n.v"): string => `<!doctype html><html><body>${`<p data-tb-text="${key}">?</p>`.repeat(n)}</body></html>`;
  const inlinedBytes = (served: string, slotCount: number): number => Buffer.byteLength(served, "utf8") - Buffer.byteLength(clean(slots(slotCount)).replace(/>\?</g, "><"), "utf8");
  it("escapedTextBytes matches the serializer", () => {
    for (const t of ["plain", "a<b>c&d", "\u00a0nbsp\u00a0", "ü€😀", "<".repeat(1000), "&amp;"]) {
      const served = bindData(clean('<p data-tb-text="n.v">?</p>'), { n: { v: t } });
      const inner = /<p data-tb-text="n.v">(.*)<\/p>/s.exec(served)?.[1] ?? "";
      assert.equal(Buffer.byteLength(inner, "utf8"), escapedTextBytes(t), JSON.stringify(t));
    }
  });
  it("a value of '<' characters (4x larger when escaped) is cut at the cap as served, not as raw", () => {
    // 200 slots × 1,999 '<' = 400 KB raw would pass a raw count only partly; escaped it is 4x that
    const page = clean(slots(200));
    const served = bindData(page, { n: { v: "<".repeat(1999) } });
    assert.ok(served.includes(BIND_CUT_MARKER) || !served.includes("&lt;"), "cut");
    assert.ok(inlinedBytes(served, 200) <= BIND_MAX_TOTAL_BYTES + BIND_CUT_MARKER.length, `${inlinedBytes(served, 200)} bytes inlined`);
  });
  it("one key shown in many slots counts once per slot; the marker never repeats", () => {
    const page = clean(slots(300));
    const served = bindData(page, { n: { v: "x".repeat(1999) } });
    assert.ok(inlinedBytes(served, 300) <= BIND_MAX_TOTAL_BYTES + BIND_CUT_MARKER.length, `${inlinedBytes(served, 300)} bytes`);
    assert.ok((served.match(/\[data cut/g) ?? []).length <= 1);
  });
  it("many keys: values up to the cap, then one visible marker, then nothing", () => {
    const keys = Array.from({ length: 300 }, (_, i) => `n.k${i}`);
    const page = clean(`<!doctype html><html><body>${keys.map((k) => `<p data-tb-text="${k}">?</p>`).join("")}</body></html>`);
    const values = { n: Object.fromEntries(keys.map((k) => [k.slice(2), "&".repeat(1500)])) };
    const served = bindData(page, values);
    assert.equal((served.match(/\[data cut: too much for one page\]/g) ?? []).length, 1);
    const shown = (served.match(/(&amp;){1500}/g) ?? []).length;
    assert.ok(shown * 1500 * 5 <= BIND_MAX_TOTAL_BYTES && shown >= 30, `${shown} values shown`);
  });
  it("data is text, never markup; slots in raw-text elements are left alone", () => {
    const served = bindData(clean('<p data-tb-text="n.v">?</p><style data-tb-text="n.v">a{color:red}</style>'), { n: { v: '<img src=x onerror="go()">' } });
    assert.ok(served.includes("&lt;img src=x onerror=\"go()\"&gt;"));
    assert.ok(served.includes("<style data-tb-text=\"n.v\">a{color:red}</style>"));
    assert.deepEqual(violations(served), []);
  });
});

describe("fail closed", () => {
  it("over the size cap, a non-string, null, a pathologically deep document: the fixed document", () => {
    clearSanitizeCache();
    assert.equal(servedDocument("x".repeat(2 * 1024 * 1024 + 1)), BLOCKED_DOCUMENT);
    const hostile = { length: 1, replace() { throw new Error("boom"); }, [Symbol.toPrimitive]() { throw new Error("boom"); } } as unknown as string;
    assert.equal(servedDocument(hostile), BLOCKED_DOCUMENT);
    assert.equal(servedDocument(null as unknown as string), BLOCKED_DOCUMENT);
    const deep = servedDocument("<div>".repeat(200_000));
    assert.ok(deep === BLOCKED_DOCUMENT || violations(deep).length === 0);
    assert.throws(() => sanitizeHtml("<template>".repeat(700)));
  });
  it("the fixed document names no network claim, carries no agent text and runs no script", () => {
    assert.ok(!/network|internet/i.test(BLOCKED_DOCUMENT));
    assert.match(BLOCKED_DOCUMENT, /cannot be shown/);
    assert.deepEqual(violations(BLOCKED_DOCUMENT), []);
    assert.equal(servedDocumentInfo("<a ".repeat(40_000)).runsScripts, false);
  });
  it("a serve-time result is cached (same bytes the second time)", () => {
    clearSanitizeCache();
    const a = servedDocument('<p>x</p><img src="http://x.test/a">');
    assert.equal(servedDocument('<p>x</p><img src="http://x.test/a">'), a);
    assert.deepEqual(violations(a), []);
  });
});

describe("seeded fuzz against the independent oracle", () => {
  const PIECES = [
    '<img src="http://x.test/1.png">', "<img src=//x.test/2>", '<a href="http://x.test/">l</a>', '<link rel=prerender href="http://x.test/p">', '<base href="//x.test/">',
    '<meta http-equiv=refresh content="0;url=http://x.test">', '<script type=speculationrules>{"prerender":[{"urls":["http://x.test"]}]}</script>', "<script>var a=1<2;</script>",
    "<style>@import url(//x.test/a.css);a{background:url(http://x.test/b)}</style>", '<div style="background:url(//x.test/c)">', "</div>", "<svg>", "</svg>", "<math>", "</math>",
    '<svg><use href="http://x.test/s#a"/></svg>', "<select>", "</select>", "<table>", "<tr><td>", "</table>", "<template>", "</template>", "<textarea>", "</textarea>",
    "<title>", "</title>", "<noscript>", "</noscript>", "<iframe srcdoc='<img src=http://x.test/f>'>", "</iframe>", "<style>", "</style>", "<script>", "</script>", "<!--", "-->",
    "<![CDATA[", "]]>", "<p>", "</p>", "<b>", "</b>", "<form action=http://x.test>", "</form>", "<button formaction=//x.test>", "<foreignObject>", "<mglyph>", "<mtext>",
    "<annotation-xml encoding=text/html>", "&lt;", "&#x68;ttp://x.test", "<img src=\"", "\">", "'", '"', "<", ">", "=", "/", " ", "\n", "text ", "<!doctype html>", "<html>", "<body>",
    '<video poster="http://x.test/p"><source src="//x.test/v"></video>', "<input type=image src=http://x.test/i>", "<object data=http://x.test/o>", "<embed src=http://x.test/e>",
    '<p data-tb-text="n.v">', '<p onclick="go()">',
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
  it("3000 random documents, both renders: nothing the oracle flags, a second pass removes nothing, filled slots stay clean", () => {
    const r = rng(20261018);
    let blocked = 0;
    for (let i = 0; i < 3000; i++) {
      const n = 1 + Math.floor(r() * 24);
      let html = "";
      for (let k = 0; k < n; k++) html += PIECES[Math.floor(r() * PIECES.length)];
      for (const allowScripts of [true, false]) {
        const out = sanitizeAgentDocument(html, { allowScripts, assetPrefix: ASSET_PREFIX });
        if (!out.ok) {
          blocked++;
          assert.equal(out.html, BLOCKED_DOCUMENT);
          continue;
        }
        assert.deepEqual(violations(out.html), [], `input: ${JSON.stringify(html)}\noutput: ${out.html}`);
        if (!allowScripts) assert.ok(!out.runsScripts && scriptsIn(out.html) === 0, `scriptless render has a script: ${JSON.stringify(html)}`);
        assert.deepEqual(sanitizeAgentDocument(out.html, { allowScripts, assetPrefix: ASSET_PREFIX }).removed, [], `a second pass still removes something: ${JSON.stringify(html)}`);
        if (!allowScripts) assert.deepEqual(violations(bindData(out.html, { n: { v: '<img src="http://x.test/v">' } })), []);
      }
    }
    assert.ok(blocked < 60, `too many documents failed closed: ${blocked}`);
  });
});
