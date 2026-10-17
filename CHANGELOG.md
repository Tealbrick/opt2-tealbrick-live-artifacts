# Changelog

All notable changes to Live Artifacts. One section per released version (handbook §3.2).

## Unreleased (0.1.0)
- Scaffold from create-tealbrick-miniapp (template ci-v9.10); pins miniapp-sdk 0.1.25, manifest 0.1.18, conformance 0.1.18, ui 0.2.4. Refs: C160, C167
- S1 core: manifest (15 ops: 7 agent, 8 owner; scope `gallery`; read-only companions Knowledge + Task Board), baseline migration, galleries (own + shared), artifact create/update/get/list/delete, immutable versions with a live pointer, staging on shared pages, pushed data, the contract with later-stage fields refused, write-time HTML lint, limits; agents never receive values read from other apps (C88). Refs: C167
- S2 viewer path (local; served once LA-1 gives the bridge a views origin): shell + sandboxed document + data endpoint, `tbv_` tokens stored as digests, uniform 404, link version binding, viewer/preview data visibility (staged and unapproved data never shown), ETag, per-day view counts, owner preview ticket (10 min; `view_origin_missing` until LA-1), document served only into a frame (Fetch Metadata), no-egress canary suite in real Chrome (local evidence). Refs: C167
