# Static content operator notes

Static mappings register an explicit normalized main-project `projectRoot`.
The mapping metadata lives in the owning instance's agent directory at
`omp-web-static-mappings.json`; content lives below `static/<mapping-id>/`.
Discovery and management are project-aware: a signed-in user sees and manages
only mappings whose machine they are granted AND whose `projectRoot` is inside
their project grants; historical rows without a project key are admin-only.
Direct serving of a known mapping URL deliberately stays authentication +
machine-grant only — it does not check the project grant.

## Stable machine identity

Set `OMP_WEB_MACHINE_ID` on every fleet instance before publishing static
content. It is the stable, lowercase URL segment used in `publicPath` and in
`/static/<machine-id>/...` links. It MUST be unique in the gateway's machine
registry and MUST remain unchanged across package upgrades, host renames, and
service restarts. The gateway's configured value must match the gateway
registry ID used when it proxies a remote machine.

If `OMP_WEB_MACHINE_ID` is absent or invalid, omp-web slugifies
`OMP_WEB_MACHINE_NAME` (lowercase ASCII letters/digits and hyphens) as a
compatibility fallback. If that also cannot produce a valid ID, it uses
`local`. Do not rely on either fallback for a fleet deployment: a changed
machine name changes public links, and `local` is not a remote registry ID.

Recommended mapping for the current fleet (for remote rows, the right-hand
value is both the remote registry ID and that host's `OMP_WEB_MACHINE_ID`):


| Host | Address | Stable ID |
| --- | --- | --- |
| Gateway | `172.30.3.123` | `gateway` |
| AI server | `172.30.3.250` | `joysort-ai-server` |
| JoySort 24 | `172.30.3.24` | `joysort24` |
| JoySort 109 | `172.30.3.109` | `joysort109` |
| GPU development | `172.30.3.202` | `gpu-dev` |
| JoySort 39 | `172.30.3.39` | `joysort39` |
| JoySort 110 | `172.30.3.110` | `joysort110` |
| Canary | `172.30.3.187` | `joysort187` |

The gateway's machine registry entry remains the synthetic `local` target; its
own public static identity may still be configured as `gateway` as shown above.

The registry is authoritative for the IDs actually used at a deployment. If a
host is registered under a different ID, configure that exact ID on the host;
do not create a second alias merely for static content.

## Session-host API

The packaged same-user local API is the primary API for agent sessions. Use the
fleet checkout entrypoint below; it shares the runtime dependency tree used by
the running omp-web service:

```sh
STATIC_CONTENT_CLI="${OMP_WEB_STATIC_CONTENT_CLI:-/home/joysort/omp/ompweb/ops/static-content/cli.ts}"
printf '%s\n' '{"command":"create","label":"report","projectRoot":"/opt/workspace/designer","lifecycle":"temporary","ttlSeconds":3600,"entryFile":"index.html"}' \
  | bun --bun "$STATIC_CONTENT_CLI"
```

For a source checkout, worktree, or custom deployment, set
`OMP_WEB_STATIC_CONTENT_CLI` to its absolute `ops/static-content/cli.ts` path.
The selected CLI MUST use the same checkout/runtime dependency tree as the
running omp-web service; a packaged source overlay with dependencies installed
elsewhere may fail to resolve `@oh-my-pi`.

The CLI reads the host's existing agent-directory/profile environment; it does
not make an HTTP request and does not need browser credentials. It accepts one
JSON command from stdin (or one JSON argument). Commands are `create`, `list`,
`update`, and `revoke`; `op` and `action` are accepted aliases for `command`.
Create and update responses include `writeDir` and the origin-relative
`publicPath`. Write generated files only below the returned `writeDir`.

`create` requires `projectRoot`: an absolute path naming the main project the
mapping belongs to. The CLI normalizes it — a git worktree checkout collapses
to its main repository root, any other directory stays itself — and persists
the result. Relative paths and backslash/NUL-containing values are rejected;
dot segments, duplicate separators, and trailing slashes are normalized.
`projectRoot` is fixed at registration and is not patchable.

For source/worktree operation, set `OMP_WEB_STATIC_CONTENT_CLI` to the absolute
worktree `ops/static-content/cli.ts` path. Do not guess a host name or prepend
a domain to `publicPath`.

Generated output must return a complete origin-relative public path, normally
`/static/<machine-id>/<mapping-id>/index.html`. Never hard-code a hostname or a
protocol URL (`http://…` / `https://…`) in returned links or generated HTML.
omp-web is reachable through several configured domain exits across regions;
an origin-relative link resolves against whichever origin the reader already
authenticated on, while a hard-coded domain sends the reader to a different
origin and forces cross-domain re-authentication (or fails outright when that
exit is not configured for them). Links inside generated HTML must therefore
stay relative: asset names relative to the document, or origin-relative
`/static/…` paths.

Examples:

```json
{"command":"list"}
{"command":"update","id":"report","input":{"entryFile":"index.html","persistent":true}}
{"command":"revoke","id":"report","content":"retain"}
{"command":"revoke","id":"report","content":"delete"}
```

`revoke` removes the mapping metadata. `content=retain` leaves the content
directory on disk but unbinds it from serving; `content=delete` also removes
the directory. The revoke response contains a deletion snapshot and
`contentDeleted`; the snapshot is not a persisted revoked row.

## HTTP API

The authenticated HTTP API remains the management surface for the Settings UI
and Gateway proxy. It is not the session skill's primary API, and callers must
use the current instance's authenticated origin rather than an unknown or
unauthenticated endpoint.

- `GET /api/static-mappings` — list this machine's mappings, filtered to the
  signed-in user's project grants (legacy rows admin-only). Through the
  Gateway proxy the same filter is applied to the remote response.
- The `/static` landing page and Home Static content tab aggregate the
  project-filtered per-machine responses. Remote reads use the machine's own
  credential at the Gateway; browser cookies/authorization are never forwarded.
  A response whose rows are not all browser-renderable (missing or mistyped
  fields the list renders/links) counts as a per-machine failure: zero rows
  plus a compact notice, never a blanked or crashed list. `projectRoot` is not
  required client-side — legacy rows stay renderable and admin-gated.
- `POST /api/static-mappings` — create a mapping; `projectRoot` is required.
  Non-admin callers may only register under a project root they can see.
- `GET/PATCH /api/static-mappings/:id` — read/update lifecycle, expiry, label,
  or entry file. Non-admin callers need the mapping's `projectRoot` visible;
  hidden and legacy rows read as 404.
- `DELETE /api/static-mappings/:id?content=retain|delete` — explicit revoke with
  the retain/delete behavior above; same project gate as PATCH.
- `GET /api/static/:mappingId/:asset...` — authenticated internal content
  route used by the Gateway.
- `GET /static/:machineId/:mappingId/:asset...` — authenticated public path;
  the Gateway streams registered remote machine bytes without forwarding the
  browser's cookie or authorization header.
- A bare mapping URL (`GET /static/:machineId/:mappingId`, with or without a
  trailing slash) serves `index.html`, falling back to `index.htm`; if neither
  exists it is 404. Directories are never listed. The Gateway forwards the
  bare internal path (`GET /api/static/:mappingId`) so remote machines apply
  the same index fallback and 404 behavior.

Generated HTML, SVG, and XML document responses carry a restrictive CSP:
inline/external scripts and network connections are disabled, while same-origin
local styles, images, fonts, and media remain available for ordinary reports.
