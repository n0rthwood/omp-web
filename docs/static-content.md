# Static content operator notes

Static mappings are machine-scoped and project-independent. The mapping metadata
lives in the owning instance's agent directory at
`omp-web-static-mappings.json`; content lives below `static/<mapping-id>/`.
A mapping is not an ACL boundary: any authenticated user granted the machine
may manage its mappings.

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
printf '%s\n' '{"command":"create","label":"report","lifecycle":"temporary","ttlSeconds":3600,"entryFile":"index.html"}' \
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

For source/worktree operation, set `OMP_WEB_STATIC_CONTENT_CLI` to the absolute
worktree `ops/static-content/cli.ts` path. Do not guess a host name or prepend
a domain to `publicPath`.

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

- `GET /api/static-mappings` — list machine-wide mappings.
- `POST /api/static-mappings` — create a mapping.
- `PATCH /api/static-mappings/:id` — update lifecycle, expiry, label, or entry file.
- `DELETE /api/static-mappings/:id?content=retain|delete` — explicit revoke with
  the retain/delete behavior above.
- `GET /api/static/:mappingId/:asset...` — authenticated internal content
  route used by the Gateway.
- `GET /static/:machineId/:mappingId/:asset...` — authenticated public path;
  the Gateway streams registered remote machine bytes without forwarding the
  browser's cookie or authorization header.

Generated HTML, SVG, and XML document responses carry a restrictive CSP:
inline/external scripts and network connections are disabled, while same-origin
local styles, images, fonts, and media remain available for ordinary reports.
