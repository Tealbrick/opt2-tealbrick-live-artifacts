# Security notes: what a Live Artifacts page can and cannot do

Pages are written by AI agents and open in the viewer's browser. This file states the containment and its known limits.
It is the threat model of record for the app (the longer design is internal).

## What holds

- A page runs in an opaque origin: `sandbox allow-scripts`, no `allow-same-origin`. It has no cookies, no storage, no
  access to the parent, and it cannot read your Tealbrick data or session.
- The document CSP has `default-src 'none'`, `connect-src 'none'`, `frame-src 'none'`, `form-action 'none'`; the shell frames only
  document tickets that are not the link token.
- Every document is sanitized on the server before it is served (owner preview and public link; `src/sanitize.ts`, parse5).
  It removes `<link>` (every rel), `<base>`, `<meta http-equiv>`, `<portal>`, frames and objects, `<script type=speculationrules>`,
  every URL attribute (`src`, `href`, `srcset`, `action`, `formaction`, `ping`, `poster`, `background`, `xlink:href` …) that is not
  `data:` or relative (an element that loads the address, such as `img`, `video`, `input`, `script`, `use`, is removed with its
  content; on any other element, such as a link, a form, `body` or `td`, only the attribute goes and the content stays), and every
  CSS `url()`, `@import` and `image-set()` that is not `data:` or relative (the `url()` becomes `url("data:,")`). If the parser fails, the page is too large or too deeply nested,
  or the sanitized output does not pass a second parse, the fixed "This page cannot be shown" document is served.
- A page without script (decided by the server from the sanitized document: no `<script>`, no inline event handler) is served as a
  scriptless render: CSP `script-src 'none'` and a sandbox without `allow-scripts`, data inlined at serve time (`data-tb-text`),
  no fetch. A link the owner approved for a page without scripts always shows the scriptless render, even if a later version gains
  scripts (`la_link.scripts_ok`). A page that runs scripts needs the owner to approve the sentence "This page runs scripts. In some
  browsers, scripts can contact outside sites, so viewers' IP addresses and anything they type can reach those sites."; the share
  request is bound to it (`expect.runsScripts`).
- A page WITHOUT script therefore makes no network request by static markup (checked by `test/browser/canary.test.ts` with Chrome on a developer machine; it is not a CI gate).

## After a restore

A restore replaces the database with an older copy. A link revoked after that backup would be active again in it, and the app cannot
know which. So the SDK `afterRestore` hook marks the boot, no link opens until the app has recorded the restore, and then **every
viewer link is ended and every preview deleted** (each page's activity says why). Pages, versions, data, sources and hold flags
stay as restored; an approved hold that was flagged "Do not approve" is still refused. The owner makes new links. This is tested
with a real backup and restore (`test/backup.test.ts`: a link revoked after the backup stays dead).

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
