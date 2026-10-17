// UI build without a bundler. `tsc -p tsconfig.build.json` has emitted src/ui as ES modules to dist/ui; this script
// copies the browser dependencies next to it and writes dist/ui/index.html with an import map:
// - ES module packages (@opt2-tealbrick/ui, @opt2-tealbrick/miniapp-sdk/client, ...) are copied file by file, only
//   the files reachable from dist/ui/main.js;
// - React ships CommonJS only, so each React entry it needs is wrapped once into an ES module (production build);
// - C61: everything except index.html is finally moved into dist/ui/assets-<content hash>/ (relative imports keep
//   working: the layout inside is unchanged). The SDK serves that directory immutable and index.html no-cache, so a
//   deploy is visible at once and assets are never re-downloaded while unchanged.
// - the kit stylesheets are linked first, then the app's own src/ui/pages.css and src/ui/app.css (when present);
//   files a kit stylesheet refers to (Nunito: ./fonts/*.woff2 + OFL.txt) are copied beside the vendored sheet, and the
//   kit's still for this product id (assets/apps/) goes to stills/ (App.tsx reads it relative to its own module URL).
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { appArt } from "@opt2-tealbrick/ui";
import { importSpecifiers } from "./import-scan.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "dist", "ui");
// a previous build's hashed directory is stale output, never an input
if (existsSync(out)) for (const d of readdirSync(out)) if (/^assets-[0-9a-f]+$/.test(d)) rmSync(join(out, d), { recursive: true, force: true });
const VENDOR = "vendor";
const STYLES = ["@opt2-tealbrick/ui/tokens.css", "@opt2-tealbrick/ui/components.css"];
/** The app's own stylesheets, after the kit sheets so they can use the tokens. pages.css = the template's page layout; app.css = this app's layout only. */
const APP_STYLES = ["pages.css", "app.css"];

/** CommonJS entries (production builds), by bare specifier: package, file inside it, package to resolve it from. */
const CJS: Record<string, { pkg: string; file: string; from?: string }> = {
  react: { pkg: "react", file: "cjs/react.production.js" },
  "react/jsx-runtime": { pkg: "react", file: "cjs/react-jsx-runtime.production.js" },
  "react-dom": { pkg: "react-dom", file: "cjs/react-dom.production.js" },
  "react-dom/client": { pkg: "react-dom", file: "cjs/react-dom-client.production.js" },
  scheduler: { pkg: "scheduler", file: "cjs/scheduler.production.js", from: "react-dom" },
};

const fail = (msg: string): never => {
  throw new Error(`build-ui: ${msg}`);
};
const posix = (p: string) => p.split(sep).join("/");
const requireFrom = (file: string) => createRequire(file);
const pkgDir = (name: string, fromFile: string) => dirname(realpathSync(requireFrom(fromFile).resolve(`${name}/package.json`)));

/** Nearest package.json above `file` that has a name. */
function owningPackage(file: string): { name: string; dir: string } {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    const pj = join(dir, "package.json");
    if (!existsSync(pj)) continue;
    const name = (JSON.parse(readFileSync(pj, "utf8")) as { name?: string }).name;
    if (name) return { name, dir };
  }
  return fail(`no package.json above ${file}`);
}

const importMap: Record<string, string> = {};
const mapTo = (spec: string, url: string) => {
  if (importMap[spec] && importMap[spec] !== url) fail(`${spec} resolves to two files (${importMap[spec]}, ${url}); dedupe the dependency`);
  importMap[spec] = url;
};
/** Output path of a dependency file, keeping its layout inside its package (relative imports stay valid). */
function destOf(file: string): string {
  if (file.startsWith(out + sep)) return file;
  const pkg = owningPackage(file);
  return join(out, VENDOR, pkg.name, relative(pkg.dir, file));
}
function vendorPath(file: string): string {
  const dest = destOf(file);
  if (dest !== file) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(file, dest);
  }
  return dest;
}
const urlOf = (dest: string) => `./${posix(relative(out, dest))}`;

// 1. ES modules reachable from the entry
const entry = join(out, "main.js");
if (!existsSync(entry)) fail("dist/ui/main.js is missing; run tsc -p tsconfig.build.json first");
const cjsNeeded = new Set<string>();
const seen = new Set<string>();
const queue = [entry];
while (queue.length > 0) {
  const file = queue.pop() as string;
  if (seen.has(file)) continue;
  seen.add(file);
  vendorPath(file);
  for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
    if (spec.startsWith("./") || spec.startsWith("../")) {
      const target = resolve(dirname(file), spec);
      if (!existsSync(target)) fail(`${file} imports missing ${spec}`);
      queue.push(target);
    } else if (spec in CJS) cjsNeeded.add(spec);
    else if (spec.startsWith("node:") || builtinModules.includes(spec)) fail(`${file} imports the Node built-in ${spec}; it cannot run in a browser`);
    else {
      const target = realpathSync(requireFrom(file).resolve(spec));
      mapTo(spec, urlOf(destOf(target)));
      queue.push(target);
    }
  }
}

// 2. CommonJS entries wrapped into ES modules (their own requires become imports through the same map)
const pending = [...cjsNeeded];
const wrapped = new Set<string>();
while (pending.length > 0) {
  const spec = pending.pop() as string;
  if (wrapped.has(spec)) continue;
  wrapped.add(spec);
  const def = CJS[spec] ?? fail(`unknown CommonJS entry ${spec}`);
  const base = def.from ? pkgDir(def.from, join(root, "package.json")) : root;
  const file = join(pkgDir(def.pkg, join(base, "package.json")), def.file);
  const source = readFileSync(file, "utf8");
  const deps = [...new Set([...source.matchAll(/\brequire\("([^"]+)"\)/g)].map((m) => m[1] as string))];
  for (const d of deps) {
    if (!(d in CJS)) fail(`${spec} requires ${d}, which is not in the CommonJS table`);
    pending.push(d);
  }
  const names = Object.keys(requireFrom(file)(file) as object).filter((n) => n !== "default" && /^[A-Za-z_$][\w$]*$/.test(n));
  const dest = join(out, VENDOR, "cjs", `${spec}.js`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(
    dest,
    [
      `// ${spec}: ${posix(relative(root, file))} wrapped as an ES module by scripts/build-ui.ts`,
      ...deps.map((d, i) => `import __dep${i} from ${JSON.stringify(d)};`),
      `const __deps = { ${deps.map((d, i) => `${JSON.stringify(d)}: __dep${i}`).join(", ")} };`,
      "const module = { exports: {} };",
      "(function (module, exports, require, process) {",
      source,
      '})(module, module.exports, (id) => __deps[id], { env: { NODE_ENV: "production" } });',
      "export default module.exports;",
      names.length ? `export const { ${names.join(", ")} } = module.exports;` : "",
      "",
    ].join("\n"),
  );
  mapTo(spec, urlOf(dest));
}

// 3. stylesheets + index.html
/** Files a vendored stylesheet refers to with a relative url() (fonts) are copied to the same relative place. */
function copyCssAssets(source: string, vendored: string): void {
  const refs = new Set([...readFileSync(source, "utf8").matchAll(/url\(\s*["']?(\.{1,2}\/[^"')?#]+)/g)].map((m) => m[1] as string));
  for (const ref of refs) {
    const from = resolve(dirname(source), ref);
    if (!existsSync(from)) fail(`${source} refers to ${ref}, which is not in the package`);
    const to = resolve(dirname(vendored), ref);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    const licence = join(dirname(from), "OFL.txt"); // the font licence travels with the font
    if (existsSync(licence)) copyFileSync(licence, join(dirname(to), "OFL.txt"));
  }
}
const links = STYLES.map((s) => {
  const file = realpathSync(requireFrom(join(root, "package.json")).resolve(s));
  const vendored = vendorPath(file);
  copyCssAssets(file, vendored);
  return `<link rel="stylesheet" href="${urlOf(vendored)}" />`;
});
for (const name of APP_STYLES) {
  const file = join(root, "src", "ui", name);
  if (!existsSync(file)) continue;
  copyFileSync(file, join(out, name));
  links.push(`<link rel="stylesheet" href="./${name}" />`);
}
// the kit's still for this product id (interim lookup by id, kit APPS table); an unknown id has none and gets the neutral header
const productId = (JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as { id: string }).id;
const art = appArt(productId, "stills/");
if (art) {
  const apps = join(pkgDir("@opt2-tealbrick/ui", join(root, "package.json")), "assets", "apps");
  mkdirSync(join(out, "stills"), { recursive: true });
  for (const url of [art.still, art.still2x]) {
    if (!url) continue;
    const file = url.slice("stills/".length);
    if (!existsSync(join(apps, file))) fail(`the kit has no ${file} in assets/apps`);
    copyFileSync(join(apps, file), join(out, "stills", file));
  }
}
const html = readFileSync(join(root, "src", "ui", "index.html"), "utf8");
const marker = /<!-- tb:head[^>]*-->/;
if (!marker.test(html)) fail("src/ui/index.html has no <!-- tb:head --> marker");
const sorted = Object.fromEntries(Object.entries(importMap).sort(([a], [b]) => a.localeCompare(b)));
// 4. content-hashed asset directory (C61): hash = sha256 over every emitted file (path + bytes), sorted
const files: string[] = [];
const walk = (dir: string) => {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) walk(p);
    else if (p !== join(out, "index.html")) files.push(p);
  }
};
walk(out);
files.sort();
const h = createHash("sha256");
for (const f of files) h.update(posix(relative(out, f))).update("\0").update(readFileSync(f)).update("\0");
const assets = `assets-${h.digest("hex").slice(0, 16)}`;
mkdirSync(join(out, assets));
for (const entryName of readdirSync(out)) if (entryName !== assets && entryName !== "index.html") renameSync(join(out, entryName), join(out, assets, entryName));
const hashed = (url: string) => (url.startsWith("./") ? `./${assets}/${url.slice(2)}` : url);
const hashedMap = Object.fromEntries(Object.entries(sorted).map(([k, v]) => [k, hashed(v)]));
const hashedLinks = links.map((l) => l.replace(/href="(\.\/[^"]+)"/, (_m, u: string) => `href="${hashed(u)}"`));
const headHashed = [...hashedLinks, `<script type="importmap">${JSON.stringify({ imports: hashedMap })}</script>`].join("\n    ");
const page = html.replace(marker, headHashed).replace(/(<script\b[^>]*\bsrc=")(\.\/[^"]+)"/g, (_m, pre: string, u: string) => `${pre}${hashed(u)}"`);
if (/src="\.\/main\.js"/.test(page)) fail("index.html still points at the un-hashed main.js");
writeFileSync(join(out, "index.html"), page);
console.log(`build-ui: ${seen.size} modules, ${wrapped.size} CommonJS wrappers, ${links.length} stylesheets -> dist/ui/${assets}`);
