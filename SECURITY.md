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
  every element whose URL attribute (`src`, `href`, `srcset`, `action`, `formaction`, `ping`, `poster`, `background`,
  `xlink:href` …) is not `data:` or relative, and every CSS `url()`, `@import` and `image-set()` that is not `data:` or relative.
  A link or form keeps its text and loses only its address. If the parser fails, the page is too large or too deeply nested,
  or the sanitized output does not pass a second parse, the fixed "This page cannot be shown" document is served.
- A page WITHOUT script therefore makes no network request by static markup (proved in real Chrome by `test/browser/canary.test.ts`).

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
  passwords here". The channels measured per run are in the canary test output.
- **R4 Copying.** Anything a page shows to a viewer can be copied. Data sources default to "not shown to people with a link".
- **R5 Link tokens in hosting logs.** Our code never logs the link token in the path. The hosting platform's own HTTP logs in the
  customer's project (owner access only) can contain the request path, so a token can appear there. Accepted: short default
  lifetime (7 days, at most 90), one-click revoke, `Referrer-Policy: no-referrer`.
  The token cannot move into the URL fragment without a script in the shell: the shell is not script-free, and a fragment is never
  sent to the server, so reading it needs script. Not done.

## Next step for public links

A stronger option is a "declarative-only" page for public links, built from the artifact SDK's blocks with no raw script. See the
effort estimate in the S6 hardening notes; it is not built.
