---
name: static-content
description: "Publish generated static files through the omp-web static-content API and return their public link."
---

# Static content

Use this skill when the user needs generated HTML, CSS, JavaScript, images, or
other static bytes served by omp-web. Every new mapping registers the explicit
normalized **main-project `projectRoot`** it belongs to. Discovery (the
`/static` landing page, the Home Static content tab, and the management list)
is project-aware: a signed-in user sees only mappings whose machine they are
granted AND whose `projectRoot` is inside their project grants. Direct serving
of a known mapping URL deliberately stays authentication + machine-grant only
— it does not check the project grant.

## Rules

- Serve static bytes only. Never expose server-side code or invoke generated
  files as code.
- Register every new mapping with `projectRoot`: the absolute path of the
  main project the output belongs to. If you are working in a git worktree,
  pass the worktree path or the main checkout path — the CLI collapses a
  worktree to its canonical main-project root. Never omit it; creates without
  a valid absolute `projectRoot` are rejected.
- Do not construct a host name, origin, machine ID, mapping ID, or public URL
  yourself. Use the `publicPath` returned by the CLI exactly. It is a complete
  origin-relative public path, normally `/static/<machine-id>/<mapping-id>/index.html`.
- Write generated files under the returned `writeDir`; do not write them into
  the project tree or guess the server's storage directory.
- The local CLI is the primary session-host API. It is a same-user local
  execution surface: it does not make an HTTP request and never needs browser
  credentials.
- In the final response, return only the returned `publicPath` link — a
  complete origin-relative path, normally
  `/static/<machine-id>/<mapping-id>/index.html` (no invented domain and no
  extra explanation).
- Generated output must use origin-relative links only. Never hard-code a
  hostname or a protocol URL (`http://…` / `https://…`) in returned links or
  in generated HTML. omp-web is reachable through several configured domain
  exits across regions; an origin-relative link resolves against whichever
  origin the reader already authenticated on, while a hard-coded domain sends
  the reader to a different origin and forces cross-domain re-authentication
  (or fails outright when that exit is not configured for them).

## Primary API: local packaged CLI

Use the fleet checkout entrypoint (it shares the runtime dependency tree used by
the running omp-web service):

```sh
STATIC_CONTENT_CLI="${OMP_WEB_STATIC_CONTENT_CLI:-/home/joysort/omp/ompweb/ops/static-content/cli.ts}"
```

Set `OMP_WEB_STATIC_CONTENT_CLI` to an absolute `ops/static-content/cli.ts`
path for a source checkout, worktree, or custom deployment. The selected CLI
path MUST belong to the same checkout/runtime dependency tree as the running
omp-web service; invoking a packaged overlay whose dependencies live elsewhere
can fail to resolve `@oh-my-pi`.

The optional override is for source/worktree or custom deployment operation.

```sh
printf '%s\n' '{"command":"create","label":"report","projectRoot":"/opt/workspace/designer","lifecycle":"temporary","ttlSeconds":3600,"entryFile":"index.html"}' \
  | bun --bun "$STATIC_CONTENT_CLI"
```

Supported commands are `create`, `list`, `update`, and `revoke`. `op` and
`action` are accepted aliases for `command`; `input`/`patch`/`mapping` are
accepted as the nested mutation object. Create and update responses include
`writeDir` and the origin-relative `publicPath`:

```json
{
  "mapping": {
    "id": "...",
    "label": "...",
    "projectRoot": "/opt/workspace/designer",
    "lifecycle": "temporary",
    "state": "active",
    "entryFile": "index.html",
    "expiresAt": "...",
    "contentRetained": true
  },
  "writeDir": "/server-provided/writable/directory",
  "publicPath": "/static/<machine-id>/<mapping-id>/index.html"
}
```

Do not construct a URL from the machine name or from a guessed host. Write
every generated asset beneath the returned `writeDir`, using normal relative
asset names, then use the returned `publicPath` exactly. Links inside generated
HTML must stay relative (asset names relative to the document, or
origin-relative `/static/…` paths) so they keep working on every configured
domain exit without cross-domain re-authentication.
The `publicPath` is an origin-relative HTTP URL (`/static/<machine-id>/<mapping-id>/…`), **not** a local filesystem path. omp-web's Markdown renderer and chat link resolver treat `/static/…` as a network link that opens in the browser (new tab); it is never resolved against the local file tree or sent to the file viewer. You can paste it into chat, Markdown, or HTML `href`/`src` attributes directly. Never pass a `publicPath` to `/api/files` or to any local file API.


### Create

`projectRoot` is **required**: an absolute path naming the main project the
mapping belongs to. The CLI normalizes it — a git worktree checkout resolves
to its main repository root, any other directory stays itself — and persists
the result. Relative paths and backslash/NUL-containing values are rejected;
dot segments, duplicate separators, and trailing slashes are normalized. The
remaining create fields are optional: `label`, `persistent`, `ttlSeconds`,
`expiresAt`, `sessionId`, `entryFile`, and `id`; `lifecycle` is optional and
must be `temporary` or `persistent` when supplied. If omitted, the service
defaults to a temporary mapping. Use either `ttlSeconds` or an explicit ISO
`expiresAt` for a temporary mapping. Omit `id` unless a stable mapping ID is
specifically needed.

```json
{"command":"create","label":"report","projectRoot":"/opt/workspace/designer","lifecycle":"temporary","ttlSeconds":3600,"entryFile":"index.html"}
```

Choose the lifecycle deliberately:

- Temporary publication: use `lifecycle: "temporary"` and a positive
  `ttlSeconds` appropriate to the user's need. The response reports `expiresAt`.
- Durable publication: use `lifecycle: "persistent"` and omit `ttlSeconds`.
  Persistent mappings do not expire until revoked.

The `persistent` boolean is accepted as an alias for `lifecycle`; when
present, keep it consistent with `lifecycle`. `sessionId` is provenance only;
it is never an authorization boundary.

### Inspect, update, and revoke

List this machine's mappings (same-user local surface; no filtering):

```json
{"command":"list"}
```

Update a mapping by `id`. The patch accepts `label`, `lifecycle`, `persistent`,
`entryFile`, `ttlSeconds`, and `expiresAt` (`projectRoot` is fixed at
registration and is not patchable):

```json
{"command":"update","id":"report","input":{"lifecycle":"temporary","ttlSeconds":7200}}
```

Use `lifecycle: "persistent"` to remove expiry. A `null` `expiresAt` or
`ttlSeconds` follows the backend's lifecycle rules; do not save a past expiry.
Use the returned `publicPath` after every update.

Revoke explicitly and choose the content behavior:

```json
{"command":"revoke","id":"report","content":"retain"}
{"command":"revoke","id":"report","content":"delete"}
```

Both forms remove the mapping metadata and stop serving immediately.
`content: "retain"` leaves the directory on disk for same-user cleanup or
inspection but does not leave a serving row. `content: "delete"` removes both
the metadata and directory. The response contains a deletion snapshot and
`contentDeleted`; the snapshot is not a persisted revoked row.

## HTTP API for UI and Gateway

The authenticated HTTP API serves the Settings UI, the `/static` landing page,
the Home Static content tab, and the Gateway. It is not the session-host API
above. Do not instruct a session to call an unauthenticated endpoint or to
guess an origin; HTTP callers must already know the current authenticated
origin and use its normal auth/session path.

- `GET /api/static-mappings` returns `{ "machineId": "...", "mappings": [...] }`
  for this machine, filtered to the signed-in user's project grants.
  Historical rows without a `projectRoot` appear only for administrators.
- The `/static` landing page and Home Static content tab aggregate the
  project-filtered per-machine responses. Remote reads use the machine's own
  credential at the Gateway; browser cookies/authorization are never
  forwarded.
- `POST /api/static-mappings` creates a mapping with the same JSON fields as
  the local CLI, including the required `projectRoot`. Non-admin callers may
  only register under a project root they can see.
- `GET/PATCH /api/static-mappings/:id` and
  `DELETE /api/static-mappings/:id?content=retain|delete` read, update, and
  revoke. Non-admin callers need the mapping's `projectRoot` to be visible;
  hidden and legacy rows read as 404. Administrators retain full access.
- `GET /api/static/:mappingId/:asset...` serves local internal content and is
  the remote target used by the Gateway.
- `GET /static/:machineId/:mappingId/:asset...` serves the authenticated
  origin-relative public path; registered remote IDs stream bytes through the
  Gateway without forwarding browser cookies or authorization headers.
- A bare mapping URL (`GET /static/:machineId/:mappingId`, with or without a
  trailing slash) serves `index.html`, falling back to `index.htm`; if neither
  exists it is 404. Directories are never listed. The Gateway applies the same
  behavior when forwarding to a remote machine.

Generated HTML, SVG, and XML documents are served with a CSP that allows
same-origin scripts (`script-src 'self'`), so published pages can run their
own JavaScript. Network connections stay disabled (`connect-src 'none'`),
while same-origin local styles, images, fonts, and media remain available.
The server only serves these bytes as static files and never executes
anything under the mapping root.

Expired or revoked mappings stop serving immediately. Direct serving of a
known mapping URL requires authentication plus the machine grant only — it
deliberately does not require the project grant. Discovery and management are
the project-gated surfaces; never rely on them to protect bytes already
published at a known URL.
