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

## Holds

If a call answers `held`, the owner must approve it. Poll `live-artifacts__tb_hold_status` with the `holdId`,
then repeat the same call with the same idempotency key.
