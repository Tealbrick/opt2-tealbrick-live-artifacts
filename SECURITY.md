# Security notes: what a Live Artifacts page can and cannot do

Pages are written by AI agents and open in the viewer's browser. This file states the containment and its known limits.
It is the threat model of record for the app (the longer design is internal).

## What holds

- A page runs in an opaque origin: `sandbox allow-scripts`, no `allow-same-origin`. It has no cookies, no storage, no
  access to the parent, and it cannot read your Tealbrick data or session.
- The document CSP has `default-src 'none'`, `connect-src 'none'`, `frame-src 'none'`, `form-action 'none'`; the shell frames only
  document tickets that are not the link token.
- Every document is sanitized on the server before it is served (owner preview and public link) by the SDK's
  `sanitizeAgentDocument` (miniapp-sdk 0.1.31, rule list `AGENT_DOCUMENT_RULES` in the manifest package, shared with Creative;
  adapter `src/agent-document.ts`). It removes `<link>` (every rel), `<base>`, `<meta http-equiv>`, forms, frames and objects,
  `<portal>`, `<noscript>`, speculation rules and import maps, `<a ping>`, every URL attribute that is not a fragment, a raster
  `data:` image (png, gif, jpeg, webp, avif, bmp, base64) or a path under the app's own `/v/live-artifacts/_s/` (relative URLs
  go too; a link keeps its text and gets `rel="noreferrer noopener"`), `srcset`, every CSS `url()`, `image-set()` and `@import`
  (a fragment such as svg `url(#g)` stays), and SMIL that writes a URL. The output starts with `<!-- tb:sanitized v1 -->`. Before
  any parse the SDK counts tags and attributes over the WHOLE source with no context (comments, raw text and foreign content
  included), so the bomb shapes of the S6/S7 reviews are refused in milliseconds. The tree builder can still do far more work
  than the source shows, so the app also bounds every parse WHILE parse5 builds the tree (interim, the rules of miniapp-sdk
  0.1.33): depth; attributes the parser copies (re-opened formatting elements, adoption agency clones) charged attrs² against a
  budget of 4,194,304; `<html>`/`<body>` attribute merging capped at 2,048 and charged the same way; at most 200,000 elements
  per parse; and an output longer than max(4 × input, input + 1 MiB) is refused. Every failure, and an
  output that changes on a second parse, gives the SDK's fixed "This file cannot be shown." page.
- Documents are served only INTO a frame (`Sec-Fetch-Dest: iframe` gate in `src/viewer.ts`, 404 otherwise), never as a top-level
  page. So the top-level speculation-rules finding of the Creative review (a top-level document can prerender outside pages)
  does not apply here.
- A page without script (decided by the server from the sanitized document: no `<script>`, no inline event handler) is served as a
  scriptless render: CSP `script-src 'none'` and a sandbox without `allow-scripts`, data inlined at serve time (`data-tb-text`),
  no fetch. A link the owner approved for a page without scripts always shows the scriptless render, even if a later version gains
  scripts (`la_link.scripts_ok`). A page that runs scripts needs the owner to approve the sentence "This page runs scripts. In some
  browsers, scripts can contact outside sites, so viewers' IP addresses and anything they type can reach those sites."; the share
  request is bound to it (`expect.runsScripts`). The owner's own `link_create` for such a page needs `acknowledged: true` on the server too.
  With autoPublish = agent, an agent can put a different page that runs scripts under a link that already allows scripts.
- A page WITHOUT script therefore makes no network request by static markup (checked by `test/browser/canary.test.ts` with Chrome on a developer machine; it is not a CI gate).

## After a restore

A restore replaces the database with an older copy. A link revoked after that backup would be active again in it, and the app cannot
know which. So **every viewer link is ended and every preview deleted** (each page's activity says why); pages, versions, data,
sources and hold flags stay as restored, and an approved hold that was flagged "Do not approve" is still refused. The owner makes new
links. How it is kept safe: the SDK `afterRestore` hook (it runs before the store opens, and if it throws the SDK rolls the restore
back) writes `la_setting.restore_pending` into the restored file; the app ends the links and writes `restore_handled` = the same
value in ONE transaction. A pending value without a handled one means "not handled yet", also after a crash in between: no link
opens until `onStart` has ended them. The SDK writes its own restore marker (`tb_meta.restore_applied`) into the restored file
BEFORE it calls `afterRestore`, so a hard kill between the two would leave no `restore_pending`, and the next boot skips the archive
as already applied. So the app also keeps the last SDK marker it handled OUTSIDE app.db, in `TB_DATA_DIR/la-restore-epoch`: a
marker that differs from the file means a restore not handled yet; no link opens (also before `onStart`, which runs on claim while
requests are already served), `onStart` ends the links and then writes the file. Read failures fail closed. Tested with a real
backup and restore, a link revoked after the backup, a simulated crash, a simulated hard kill, and a control where nothing was
restored (`test/backup.test.ts`).

What a restore does NOT undo yet (S6/S7 re-check S3; must be fixed BEFORE the first stable promotion, Coordinator 2026-10-18):
changes the owner made after the backup come back as they were in the backup. A source hidden from link viewers (`viewers`,
`approved_digest`), a refresh schedule that was stopped, a page that was archived or deleted, and an `artifact_share` hold that was
approved but not run yet are restored with the older state. Links are ended, so nothing opens by itself, but the first new link of a
page can show data the owner had hidden after the backup. Planned fix: on restore, re-apply the revocations newer than the backup
from the audit log, or refuse to revive those approvals. The first S8 boot of a deployment that was EVER restored before S8 has an
SDK marker but no epoch file, so it ends every link once.

## App callers

No operation declares `companionCallers`: no other app can call Live Artifacts, so there is no caller to verify here
(`test/app.test.ts` fails when an operation declares one). The SDK refuses unverified app callers centrally from miniapp-sdk 0.1.34
(C261); there is no app-side guard until an operation needs app callers.

## Stored pages and the sanitizer

A page is sanitized when it is written and the result is stored with the sanitizer's rule version (`la_version.sanitizer_version`).
A row with an older version (or none: an older backup) is sanitized again when it is served, so a fix reaches stored pages. Time:
a bomb is refused in under 100 ms (before parse5, or at a parse bound while it parses; a page at the element cap costs about
100 ms); reading a stored row at serve is cheap;
**writing** costs more, because the sanitize happens there: the SDK verifies its output with two more parses, and a page with
scripts is sanitized twice (as it is, and as the scriptless render). A page at the 256 KiB cap costs about 85 ms to write; an
adversarial but legal page (a 240 KB table of 60,000 anchors) about 0.4 to 0.5 s.

## Data inlined into a scriptless page

`data-tb-text="key.path"` slots are filled by the SDK's `fillTextSlots` (text only, escaped, never into raw-text elements; keys are
lowercase paths). One response carries at most 256 KiB of inlined data counted as SERVED bytes (after escaping: `<` costs 4
bytes), times the number of slots that show a key; past it one key shows "[data cut: too much for one page]" and later ones nothing.

## Known false refusals (miniapp-sdk 0.1.31)

The SDK's context-free count reads `<` followed by a letter as a possible tag, so a benign page with 257 or more words after such a
`<` before the next `>` (a script `for(i=0;i<n;i++){…}` with a long body, prose "a<b" followed by 400 words) is refused at write
(`view_not_servable`). Fail closed, not a leak; fixed in the SDK (contracts lead, miniapp-sdk 0.1.33). The tests are in
`test/agent-document.test.ts`, skipped with that reason until the pin moves.

## Known limits (accepted)

- **R1 DNS hints.** `dns-prefetch` and `preconnect` are removed from markup; a script can still create one.
- **R2 WebRTC.** `connect-src` does not cover STUN in every browser.
- **R3 A script can contact outside sites in some browsers (C238).** Scripts stay ON in Live Artifacts (design C167). In Chrome a
  sandboxed document can reach the network through `<link rel=prerender>` added by script, through speculation rules added by
  script, and `<a>.click()` opens a TCP connection to the link target (a DNS and SNI side channel). No header closes this. The sanitizer
  cannot help against code. What it takes: attacker-written page code and a viewer who opens the page. What it gives away: that the
  viewer opened the page, from which address and when, and anything the page itself knows (what the owner chose to show on it).
  It cannot read your Tealbrick data or session. Copy for people: "The page cannot read your Tealbrick data or session. In some
  browsers it can contact outside sites. Do not type private information into it." The public-link banner keeps "never enter
  passwords here". Measured with `test/browser/canary.test.ts` (Chrome 155, Playwright, through the sanitizer and our headers, one script page per channel):
  a `<link rel=prerender>` added by script REACHES the canary (1 request); `<a>.click()` opens a TCP connection (0 requests); speculation
  rules (prerender and prefetch), `<link rel=prefetch>`, `preconnect` and `dns-prefetch` added by script did not reach it in that run;
  `fetch` is blocked by CSP. These are recorded, never asserted to be 0, and can differ by browser and version. WebRTC (R2) is not measured.
- **R4 Copying.** Anything a page shows to a viewer can be copied. Data sources default to "not shown to people with a link".
- **R5 Link tokens in hosting logs.** Our code never logs the link token in the path. The hosting platform's own HTTP logs in the
  customer's project (owner access only) can contain the request path, so a token can appear there. Accepted: short default
  lifetime (7 days, at most 90), one-click revoke, `Referrer-Policy: no-referrer`.
  The token cannot move into the URL fragment without a script in the shell: the shell is not script-free, and a fragment is never
  sent to the server, so reading it needs script. Not done.

## Next step for public links

A stronger option is a "declarative-only" page for public links, built from the artifact SDK's blocks with no raw script. See the
effort estimate in the S6 hardening notes; it is not built.
