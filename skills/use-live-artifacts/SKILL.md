---
name: use-live-artifacts
description: How {{agent.name}} saves reports and dashboards as live pages in {{workspace.name}}, proposes their data sources, and keeps them fresh.
---
# Making live pages ({{agent.name}})

A live page (an "artifact") is a small web page that you write once and the owner keeps. It is not a chat
attachment: the owner opens it again later, it can refresh itself from data the owner approved, and it keeps
working after you are gone.

Make a live page when your answer is a report, a table, a status board or a dashboard that the owner will want
to look at again. Do not make one for a one-off answer.

## Where pages live

- Your own gallery holds the pages you make; you can read, change and delete them there.
- The `shared` gallery is for pages the whole team uses; you can usually add and change pages there.
- Call `live-artifacts__galleries_list` to see the galleries you can reach and your access in each.

## Write the page

Call `live-artifacts__artifact_create` with a `title` and `view.html`. Send an idempotency key.

- One self-contained HTML file, at most 256 KiB. Inline your CSS and scripts; use `data:` URLs for images.
- The page has **no network**. External scripts, styles, fonts, images, frames and forms do not load, and
  `fetch`, `XMLHttpRequest` and `WebSocket` do not work. The answer lists `lint` advice; an error refuses the page.
- Get your data with the `tb` helper that the page always has:

```html
<div id="out">Loading…</div>
<script>
  tb.onData((data) => {
    // data.<source key> is the latest value of each source
    const tasks = data.tasks ?? [];
    document.getElementById("out").textContent = `${tasks.length} blocked tasks`;
  });
  tb.ready();
</script>
```

## Give it data

Declare the data in `contract.inputs` (at most 8 sources, each with a `key`):

- `{"key": "numbers", "kind": "push"}`: you send the data yourself with `live-artifacts__artifact_data_put`
  (`{id, key, data}`, JSON, at most 256 KiB). The page labels it "pushed by {{agent.name}}".
- `{"key": "tasks", "kind": "read", "product": "kanban", "op": "issues_list", "input": {...}, "projection": {"path": "/issues", "pick": ["title", "status"], "limit": 20}}`:
  a read of another app. The owner must approve it once, with the exact read on screen. Allowed reads are the
  Task Board and Knowledge reads listed in the error message if you name another one.
- `contract.triggers: [{"kind": "schedule", "everySeconds": 900}]` proposes a refresh schedule (300 to 86400
  seconds). The owner approves it.

Once the owner approved a read source and its schedule, the page refreshes by itself, also after you are gone.
`live-artifacts__artifact_refresh` (`{id}`) asks for a refresh now (once a minute per page); it returns the status
of each source (`ok`, `held`, `error`, `paused`, `not_approved`), never the data.

You never get the values that a read source returns. `artifact_get` with `include: ["shape"]` shows the keys,
types and row counts of the approved data so you can write the page for it. `include: ["data"]` returns only
data that agents pushed.

## Change, reuse, delete

- `live-artifacts__artifact_update` makes a new version when the HTML or the contract changes. Pass
  `expectedVersion` (from `artifact_get`) so you do not overwrite someone else's change (`version_conflict`).
  A changed read source needs the owner's approval again.
- If the page is shared with a link, your new version or data may wait for the owner (`staged: true`). That is
  normal; tell the owner what changed.
- `live-artifacts__artifact_list` and `artifact_get` find pages you can read. To start from one, call
  `artifact_create` with `fromId`.
- `live-artifacts__artifact_delete` needs manage access, and the owner approves it.

## Share with a link

A link lets people without an account open a page. Anyone who has its address can open it until it ends or the
owner revokes it, so the owner always approves a new link first.

1. Call `live-artifacts__artifact_share` with `{id, label?, expiresInDays?, pin?}` and an idempotency key.
   `label` (at most 40 characters) says who the link is for. `expiresInDays` is 1 to 90 (default: the owner's
   setting, 7 days at first). `pin` is a version number to show on that link for good; leave it out to follow the
   live version.
2. The answer is `held` with a `holdId`. The owner sees the page, how long the link lasts, which version it shows and
   which data it shows, and decides in Holds. Tell the owner a link waits for them. Poll `live-artifacts__tb_hold_status`.
3. When the hold is approved, repeat **the same call with the same idempotency key**. The answer of that retry holds
   `url`, the link address. This is the only time you see it: the app keeps a fingerprint, not the address, and
   `artifact_get` never lists it. The same call with the same key gives the same answer again for 24 hours. A
   different key or different input is a new request and needs a new approval.
4. Give the address only to the owner, or to the person the owner named. Do not post it where others read it.

Answers to expect:

- `link_needs_hold` (403): your card does not hold `public_link` yet, so the call is refused. Do not retry. Tell the
  owner to accept the `public_link` offer for you in Portal.
- `view_origin_missing` (409): the workspace has no viewer address yet. Tell the owner; Portal must redeploy the bridge.
- `links_limit_artifact` or `links_limit_workspace` (409): too many active links (5 per page, 50 in all). Ask the owner,
  or revoke a link of yours that is no longer needed.
- People with a link see only the data sources the owner marked "Show to people with a link". Read
  `artifact_get` with `include: ["links"]` for the links of a page (label, end, pin, views).

While a page has an active link, your new versions and new data wait for the owner (`staged: true`). To ask for them
to go live, call `live-artifacts__artifact_publish` with `{id, version, data?}`. It is held like a link and the owner
sees the size, digest, data keys and sources that change. List each staged data key with the `digest` that
`artifact_data_put` gave you, for example `data: [{"key": "numbers", "digest": "sha256:…"}]`; staged data you do not list
stays staged. If you pushed new data after you asked, you get `staged_changed` (409): ask again. An older `version` rolls
the page back. `nothing_to_publish` (409) means that version is live already.

`live-artifacts__artifact_link_revoke` (`{linkId}`) stops a link at once. It is never held: you may always narrow who can
see a page. The `linkId` comes from `artifact_share` or from `artifact_get` with `include: ["links"]`.

## Holds

If a call answers `held`, the owner must approve it. Poll `live-artifacts__tb_hold_status` with the `holdId`,
then repeat the same call with the same idempotency key.
