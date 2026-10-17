# Live Artifacts

A Tealbrick opt2 mini app (product id `live-artifacts`), built on `@opt2-tealbrick/miniapp-sdk`.

Live Artifacts keeps an agent's report or dashboard as a page: one self-contained HTML file written against a fixed
contract, with versions, data sources the owner approves once, and (later) a refresh schedule and viewer links the
owner controls. Pages run in a sandbox: a page cannot read your Tealbrick data or session. In some browsers it can contact outside sites, so do not type private information into it. Values read from other apps are shown to the owner, never
returned to agents. Design: `coordination/leads/live-artifacts/DESIGN.md` (internal).

`tealbrick.manifest.json` is the only description of the app. The SDK derives the routes, input and output
validation, OpenAPI, receipts, holds, idempotency, scopes, backups and status from it. You write handlers by
operation id (`src/app.ts`) and plain migrations (`migrations/`).

## Layout

| Path | Content |
|---|---|
| `tealbrick.manifest.json` | identity, runtime (data + backup volumes), operations, scopes, skills, backups, UI paths |
| `src/app.ts` | `defineApp`: one typed handler per operation (op ids and I/O types from `#kit`), gallery access, agent first-sight event |
| `src/store.ts` | the app's table access (plain functions over the SDK `Db`): artifacts, versions, sources, snapshots, links |
| `src/links.ts` | viewer links: create (caps, expiry, pin), revoke, list, and the texts the owner reads on a hold |
| `src/viewer.ts` | the viewer route handler (the SDK serves `/v/live-artifacts/…` and strips the prefix), tokens, tickets, CSPs |
| `src/contract.ts` | the artifact contract (inputs, triggers; later-stage fields refused) and the binding digest |
| `src/sanitize.ts` | the sanitizer every served agent document passes through (parse5; removes link/base/meta http-equiv/portal/speculation rules and outside URLs; fails closed to a fixed document). One call site: `servedDocument`, used by the viewer. Replaced by the SDK helper when it ships |
| `src/scripts-text.ts` | the sentence the owner approves when a page runs scripts (server and UI use the same text) |
| `SECURITY.md` | what a page can and cannot do, and the accepted residuals R1–R5 |
| `src/lint.ts` | write-time HTML lint (advice; the boundary is the sandboxed views origin) |
| `src/limits.ts` | every size and count limit |
| `tealbrick-conformance.json` | conformance setup fixtures (a page created as agent A for the id-addressed ops, inputs for the link ops) and the A9 waiver |
| `src/main.ts` | `startApp(app, process.env)` |
| `src/ui/` | React UI (`<TbProvider>` + `<AppShell>` from `@opt2-tealbrick/ui`), built to `dist/ui` |
| `src/ui/standard.tsx` | the standard pages (Holds, Receipts, Agents & scopes, Backups & export) and the page router; pass your own words as props, do not edit (one source: the template) |
| `src/ui/pages.css` | page layout helpers of the approved mockups (`.page-head`, `.ruled`, `.item`, ...); tokens only. App-only layout goes in `src/ui/app.css` (linked after it when present) |
| `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md` | Apache-2.0 (C154), the copyright notice and the upstream licences the app ships (React, the UI kit, Nunito OFL); update the notices when you add a dependency |
| `migrations/0001_init.sql` | baseline; forward-only, never edit a released file |
| `skills/use-live-artifacts/SKILL.md` | the agent skill (frontmatter `name`, `description`) |
| `scripts/build-ui.ts` | UI build without a bundler (tsc output + vendored modules + import map) |
| `gen/` (not committed) | `tb-gen` output; `node --run kit` generates the kit and compiles it to `dist/kit` (`#kit` import) |
| `Dockerfile` | `node:24-slim` pinned by digest, pnpm build to `dist/`, non-root, `CMD ["node", "dist/main.js"]` |
| `.woodpecker/ci.yaml` | the opt2 CI template, byte-identical copy (do not edit) |
| `tealbrick-ci.json` | CI settings: kind `miniapp`, one image |

## Develop

```sh
pnpm install          # commit pnpm-lock.yaml: CI installs with --frozen-lockfile
# typecheck, test, conformance, build and start first run `tb-gen kit` (op ids + I/O types from the manifest)
pnpm typecheck && pnpm lint && pnpm test      # lint = biome + check-system (the design-system guard)
pnpm build            # server to dist/, UI to dist/ui
pnpm conformance      # SDK conformance suite against this app
TB_STANDALONE=1 TB_DATA_DIR=.data pnpm start   # app-alone mode: person UI only, no agent calls
```

## Environment

The SDK reads only `TB_*` variables (SDK-API §13). The deploy recipe sets them: `TB_INSTANCE_ID`,
`TB_ENROL_CODE`, `TB_BRIDGE_URL`, `TB_PORTAL_KEYS`, `TB_KEK`, `TB_DATA_DIR` (the `data` volume mount, `/data`)
and `TB_BACKUP_DIR` (`/data/backup`: one volume per service). Optional: `TB_LOG_LEVEL`, `TB_RESTORE_FROM`,
`TB_STANDALONE`. The listen port is the manifest `runtime.port`.

Before its first claim the SDK checks that `TB_DATA_DIR` is a mounted volume (SDK 0.1.12); on a container's own
disk it waits and does not use the enrolment code. Tests and CI that run `startApp` or `tb-exec` in bridge mode on
Linux set `TB_DATA_EPHEMERAL=1` in that test or CI step (this template's own tests run app-alone and need none). Never set it in a deploy recipe.

## Release

1. Set the same version in `package.json` and `tealbrick.manifest.json`.
2. Tag `v<semver>` (for example `v0.1.0`) and push the tag.
3. CI builds and publishes the image, then writes the signed release record from the manifest.

Before the first push, check `publisher` and `source.repo` in the manifest. The repository name must match the
image name in `tealbrick-ci.json` (`opt2-tealbrick-live-artifacts`).

## Dependency pins and caching
- `pnpm-lock.yaml` carries the sha512 integrity of every GitHub-release tarball (CI rule ci-v8). After changing an `@opt2-tealbrick/*` dependency run `pnpm install`, then `node <opt2-tealbrick-platform>/ci/tb-ci.ts pin-tarballs .`, then `pnpm install --frozen-lockfile`, and commit the lockfile. Image builds run `pnpm install --frozen-lockfile --ignore-scripts`.
- `pnpm build` writes the UI to `dist/ui/index.html` + `dist/ui/assets-<content hash>/`; the SDK serves index.html `no-cache` and the hashed directory immutable, so a deploy is visible at once (C61).
