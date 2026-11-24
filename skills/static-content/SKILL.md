---
name: static-content
description: "Publish generated static files through the machine-wide omp-web static-content API and return their public link."
---

# Static content

Use this skill when the user needs generated HTML, CSS, JavaScript, images, or
other static bytes served by omp-web. Static mappings are **machine-wide and
project-independent**. They are not scoped to the current repository, cwd,
session, or project ACL. Any authenticated user who can access the machine can
manage all of that machine's mappings.

## Rules

- Serve static bytes only. Never expose server-side code, invoke generated
  files as code, or assume a project visible-root/file ACL applies.
- Do not construct a host name, origin, machine ID, mapping ID, or public URL
  yourself. Use the `publicPath` returned by the CLI exactly.
- Write generated files under the returned `writeDir`; do not write them into
  the project tree or guess the server's storage directory.
- The local CLI is the primary session-host API. It is a same-user local
  execution surface: it does not make an HTTP request and never needs browser
  credentials.
- In the final response, return only the returned `publicPath` link (no
  invented domain and no extra explanation).

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
printf '%s\n' '{"command":"create","label":"report","lifecycle":"temporary","ttlSeconds":3600,"entryFile":"index.html"}' \
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
asset names, then use the returned `publicPath` exactly.

### Create

The complete optional create fields are `label`, `persistent`, `ttlSeconds`,
`expiresAt`, `sessionId`, `entryFile`, and `id`; `lifecycle` is optional and
must be `temporary` or `persistent` when supplied. If omitted, the service
defaults to a temporary mapping. Use either `ttlSeconds` or an explicit ISO
`expiresAt` for a temporary mapping. Omit `id` unless a stable mapping ID is
specifically needed.

```json
{"command":"create","label":"report","lifecycle":"temporary","ttlSeconds":3600,"entryFile":"index.html"}
```

Choose the lifecycle deliberately:

- Temporary publication: use `lifecycle: "temporary"` and a positive
  `ttlSeconds` appropriate to the user's need. The response reports `expiresAt`.
- Durable publication: use `lifecycle: "persistent"` and omit `ttlSeconds`.
  Persistent mappings do not expire until revoked.

The `persistent` boolean is accepted as an alias for `lifecycle`; when
present, keep it consistent with `lifecycle`. `sessionId` is provenance only;
it does not turn a mapping into a project-private resource.

### Inspect, update, and revoke

List all machine-wide mappings:

```json
{"command":"list"}
```

Update a mapping by `id`. The patch accepts `label`, `lifecycle`, `persistent`,
`entryFile`, `ttlSeconds`, and `expiresAt`:

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

The authenticated HTTP API remains available to the Settings UI and Gateway.
It is not the session-host API above. Do not instruct a session to call an
unauthenticated endpoint or to guess an origin; HTTP callers must already know
the current authenticated origin and use its normal auth/session path.

- `GET /api/static-mappings` returns `{ "machineId": "...", "mappings": [...] }`.
- `POST /api/static-mappings` creates a mapping with the same JSON fields as
  the local CLI.
- `PATCH /api/static-mappings/:id` updates lifecycle, expiry, label, or entry
  file.
- `DELETE /api/static-mappings/:id?content=retain|delete` performs explicit
  revoke with the retain/delete behavior above.
- `GET /api/static/:mappingId/:asset...` serves local internal content and is
  the remote target used by the Gateway.
- `GET /static/:machineId/:mappingId/:asset...` serves the authenticated
  origin-relative public path; registered remote IDs stream bytes through the
  Gateway without forwarding browser cookies or authorization headers.

Generated HTML, SVG, and XML documents have a restrictive CSP: scripts and
network connections are disabled while same-origin local styles, images, fonts,
and media remain available for ordinary reports.

Expired or revoked mappings stop serving immediately. Never rely on repository
permissions or cwd filtering to protect a mapping.
