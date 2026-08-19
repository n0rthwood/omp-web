# The fleet gateway in omp-web

For the concrete deployed fleet — the six-host topology, systemd units,
per-host env layout, and day-2 operations (redeploy, rotate a password, add a
new host) — see the operator runbook: [fleet-deployment.md](./fleet-deployment.md).

## What it is

One omp-web instance can act as a gateway to the omp-web instances on other
machines. The gateway keeps a small registry of remote machines and forwards
their API over HTTP: agent sessions, terminals, files — everything the remote
already serves. There is no session syncing and no daemon; the remote's own
processes own its sessions and ptys, and the gateway only relays requests to
them.

The URL shape is a pure prefix insert:

    local:   /api/sessions
    remote:  /api/machines/<machineId>/api/sessions

Everything client-side goes through `apiPath()` (`lib/api-path.ts`), which
decides — from a module-level current machine id — whether a URL stays local or
gains the `/api/machines/<id>` prefix. Switching machines (the MachineSwitcher)
goes through the navigation pipeline (see
[Deeplinks, resume, and navigation](#deeplinks-resume-and-navigation) below),
which updates the URL to `/m/<id>[/p/<project>]` and remounts the app subtree
keyed by machine id: no session, file, or terminal state can leak from one
machine into another. localStorage keys that hold absolute paths or session
ids are namespaced per machine by `machineStorageKey()` (`k` → `m:<id>:k`).

The registry lives in `~/.omp/agent/omp-web-machines.json` (override with
`OMP_WEB_MACHINES_FILE`), written `0600` through the atomic-replace helper. The
synthetic machine `local` — this instance itself — is always first in listings
and can be neither modified nor deleted; its display name defaults to "This
machine" and can be set per instance with `OMP_WEB_MACHINE_NAME` (useful when
one host runs more than one instance, or to name it after the host).

## Adding a machine

`POST /api/machines` (admin-only, JSON) with:

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | display name, 1–64 characters |
| `baseUrl` | yes | absolute `http`/`https` URL; reduced to its origin (path, query, credentials stripped) |
| `authMode` | yes | `"bearer"`, `"basic"`, or `"none"` |
| `token` | for `bearer`/`basic` | the Bearer token, or the Basic password |
| `username` | `basic` only | defaults to `"omp"` |
| `headers` | no | extra static headers; `host`, `authorization`, `cookie`, `content-length`, `connection`, `transfer-encoding` are rejected |
| `id` | no | slug `^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$` — 1–39 chars, no leading or trailing hyphen, never `local`; derived from `name` if omitted |

Machines are managed with `PATCH /api/machines/<id>` (send `token: null` to
clear the credential; omit `token` to keep it) and `DELETE /api/machines/<id>`
(204). Responses only ever contain the safe projection — `id`, `name`,
`baseUrl`, `authMode`, `hasCredential`, `headerNames`, timestamps, `isLocal`.

`POST /api/machines/test` probes a machine *before* it is saved: send the same
body plus an optional `id` (meaning "reuse that machine's stored credential, I
did not retype it"). It answers `200 {ok: true, health}` or
`200 {ok: false, code, error}` — a failed probe is a successful API call, not an
HTTP error. The browser never dials a remote directly: it is cross-origin (the
remote's origin check refuses it) and it would put the credential in the page.

### Minting the credential

The credential belongs to the **remote** machine; how you get it depends on how
that remote authenticates:

- **Bearer token (preferred).** On the remote, as an admin:
  `POST /api/web-users/<username>/tokens` with body `{"name": "fleet gateway"}`.
  The response contains `raw` — a `web_…` token — shown **exactly once**; only
  its sha256 is stored on the remote. Paste that value as the machine's `token`
  with `authMode: "bearer"`.
- **Basic.** For a remote still on the `OMP_WEB_PASSWORD` migration bridge:
  `authMode: "basic"`, `username: "omp"`, `token:` the remote's
  `OMP_WEB_PASSWORD`.
- **`none`.** For a remote with auth disabled — only sane on a private network.

## Security

- **Remote machines need HTTPS or a private network.** The gateway dials the
  remote's `baseUrl` directly. Over plain `http`, the stored credential and
  everything it carries — file contents, session transcripts, terminal I/O —
  cross the wire in cleartext. Terminate TLS with a reverse proxy in front of
  the remote, or keep the traffic inside a VPN/private network.
- **Basic auth is base64, not encryption.** It is an encoding of
  `username:password` that anyone on the path can read. It is only acceptable
  where the transport is already protected (TLS, loopback, VPN).
- **A stored token grants the remote role it was minted with.** On the remote, a
  Bearer token resolves to the user it was created for, with that user's role.
  Mint it for a user whose role is exactly what you want the gateway to have on
  that machine — an admin token lets the gateway do everything an admin can.
- **`omp-web-machines.json` is written mode `0600` and its tokens are never
  returned by any API.** GET/PATCH responses use the safe projection
  (`hasCredential: boolean`, header *names* only). The browser never sees a
  machine token and never constructs a credential header — the gateway attaches
  the machine's own credential server-side and drops any `authorization` the
  caller sent.
- **Fleet configuration is admin-only; reaching a machine is per-user, grant-based.**
  Adding, editing, deleting and probing machines (`POST`/`PATCH`/`DELETE
  /api/machines[/…]`) always require the admin role — `lib/admin-api-policy.ts`
  and `requireAdminApi` enforce that in two layers, same as everywhere else in
  this app. *Reaching* an already-configured machine — listing it and proxying
  to it — is grantable per user; see
  [Per-user machine grants](#per-user-machine-grants) below. Per-user visibility
  (#7) still cannot be projected onto another machine's absolute paths: a
  granted user gets the machine's *entire* credential-backed surface, not a
  filtered one.
- **An unauthenticated gateway cannot be given machines.** `machines.json` holds
  credentials to *other* hosts, so an open gateway on a reachable interface
  would hand out lateral access to the whole registry. Adding, editing and
  probing a machine therefore require either a loopback bind or real
  authentication (`lib/machines/fleet-gate.ts`); without one you get
  `403` telling you to set `OMP_WEB_PASSWORD` or create a web user. Listing the
  registry and using machines already in it keep working, so tightening the
  bind never breaks a running fleet.
- **`baseUrl` is dialed exactly as given.** Nothing blocks loopback, RFC1918 or
  link-local addresses, and the name is resolved fresh on every request, so a
  machine's address can change under you if its DNS does. An admin already has
  a shell on the gateway through an agent session, so this grants them nothing
  new — but the registry is not a sandbox, and it should not be treated as one.
- **A stored credential is bound to the origin it was saved for.** Changing a
  machine's `baseUrl`, or probing a different one with `id`, requires
  re-entering the credential. Otherwise "write-only" would be cosmetic: anyone
  with an admin session could aim the stored secret at a host of their choosing
  and read it off the wire. Switching a machine to `authMode: "none"` deletes
  the stored credential rather than parking it on disk.

## The remote's own rules still apply

The gateway is just another authenticated client to the remote. Nothing is
relaxed on the remote side:

- **File access** is evaluated by the remote's `getAllowedFileRoots()` and its
  own web-user visibility rules. A proxied `/api/files` request can only reach
  what the machine's credential is allowed to reach on that machine.
- **The remote's Host allow-list must admit the authority the gateway dials.**
  omp-web rejects requests whose `Host` is not trusted (`OMP_WEB_HOSTNAME` /
  `OMP_WEB_ALLOWED_HOSTS`). An IP literal in `baseUrl` always passes; a
  hostname must be listed in the remote's allow-list or every proxied request
  dies with `403 Untrusted API request`.

## What is never proxied

The proxy is allow-listed by route template **and** method
(`lib/machines/proxy-allowlist.ts`): a request is forwarded only when both match
a row in a hardcoded table derived from `app/api`. Anything not in the table is
denied with `403 Proxy path not allowed` — including new routes, until they are
added to the table.

A path containing an empty, `.` or `..` segment is refused outright, in any
spelling (`%2E%2E` included). `fetch` resolves the URL before sending it, so
without that rule the table would authorize one route — `/api/files/*` accepts
any tail — while the remote received another: `/api/files/../../api/web-users`
arrives as `/api/web-users`. Authorize the path that will actually be
requested, never the one that was typed.

Four surfaces are denied outright, on purpose:

| Surface | Why |
| --- | --- |
| `/api/machines/**` | No fleet-in-fleet recursion; a gateway must not reconfigure another machine's registry |
| `/api/web-users/**` | Remote user and token management stays local to each machine |
| `/api/auth/web-login`, `/api/auth/web-logout` | The remote's login session is its own |
| `POST /api/updates` | The remote's binary updates itself; the gateway never triggers it (`GET /api/updates` — the version check — is proxied) |

Client-side, the same surfaces must keep **bare** `/api/...` URLs — they are
not routed through `apiPath()` (which would blindly gain the machine prefix,
and the proxy would reject them anyway). `web-me`, `web-login`, `web-logout`,
`web-users`, `machines`, and `updates` always address the gateway you are
logged into.

## Per-user machine grants

A file-backed web user (`~/.omp/agent/omp-web-users.yml`) carries a
`machines` field alongside `projects`: `"*"` or an array of machine ids. The
admin role always has effective access to every machine — `"*"` is implied
by the role, regardless of what is stored — a non-admin only reaches the
ids explicitly listed. `local` is implicitly granted to everyone and never
needs to appear in the list. A user created before this field existed reads
back as `machines: []` (no remote access — exactly today's pre-#10
behavior; nothing regresses on upgrade).

**Grants are pruned against the live registry on every read**, never
trusted as stored. Deleting a machine from the fleet silently drops it out
of every grant that named it — `lib/machines/machine-grants.ts`
(`pruneMachineGrants`) does the intersection; `"*"` is never pruned.
`GET /api/web-users` and `GET /api/web-users/<username>` (admin-only, same
as ever) report the pruned value, so a stale id never lingers in what an
admin sees either.

`GET /api/machines` itself now serves any authenticated user, not just
admins — the response shape differs by role:

- **Admin** gets the full `SafeMachine` projection for every machine
  (unchanged): `id`, `name`, `baseUrl`, `authMode`, `hasCredential`,
  `headerNames`, timestamps, `isLocal`.
- **User role** gets only `local` plus their granted machines, each
  slimmed to `UserVisibleMachine` — `baseUrl` and `headerNames` are
  dropped. A user role never learns a remote's origin or its configured
  static header names, even for a machine it is granted.

Every mutation (`POST`/`PATCH`/`DELETE /api/machines[/…]`) stays
admin-only; a grant only ever widens *reach*, never *configuration*
privilege.

### Two-layer enforcement on the fleet proxy

Reaching a granted machine's API (`/api/machines/<id>/api/...`) is checked
twice, the same discipline as everywhere else in this app:

1. **`proxy.ts` (outer, local-pathname gate).** `isAdminOnlyLocalApiPath`
   (`lib/admin-api-policy.ts`) special-cases `/api/machines`: the listing
   (`GET /api/machines`) is open to any authenticated user; every mutation
   on `/api/machines` or `/api/machines/<id>` (one extra segment) stays
   admin-only; the fleet-proxy catch-all
   (`/api/machines/<id>/api/...`, two or more extra segments) is **not**
   blocked here — the middleware cannot see which machine the caller is
   granted, so that decision is deferred entirely to the route guard below.
2. **`requireMachineGrant` (inner, route-level, `app/api/web-users/_guard.ts`).**
   Runs on every method the fleet-proxy catch-all accepts. In order: trust
   gate → authentication (401) → admin bypass → `local` bypass (the route's
   own 400 governs from there) → **unknown machine → 404** "Machine not
   found" → **existing-but-ungranted machine → 403** "No permission for
   this machine" → **granted but the inner remote path is admin-only
   (`isAdminOnlyRemoteApiPath`, e.g. `PUT /api/models-config`,
   `POST /api/auth/api-key/<provider>`) → 403** "Admin access required".

The 404-vs-403 split for machine identity is **deliberate, not an
oversight**: machine-id existence is not treated as a secret on this
fleet. A granted user can tell a machine id is real without being
granted to it; an admin auditing "why is my proxy request being denied"
gets a straight answer instead of a deliberately ambiguous one.

**What a grant actually hands out — read this before granting one.** A
granted user's requests to that machine carry the machine's own stored
credential, exactly like an admin's — there is no per-user credential on
the remote and no way to scope one. Concretely:

- **Full power on that machine, not a filtered view.** Whatever role the
  machine's stored credential resolves to on the remote (usually admin,
  per the "Minting the credential" note above) is what the request runs
  as. A grant is an all-or-nothing key to that machine, not a role
  mapping.
- **Per-user project visibility does not apply on remotes.** The remote
  enforces its own visibility rules against *its own* file users, and the
  gateway's proxied request never carries the granting user's identity —
  only the machine's credential. A grant is machine-wide, not
  project-scoped.
- **Revoking a grant does not close streams already open.** An SSE
  subscription or a terminal session opened while granted keeps running
  until it ends on its own; only *new* requests are checked against the
  current grant.

## Deeplinks, resume, and navigation

The app's location — which machine, project, and conversation — is a single
piece of state owned end-to-end by `lib/nav-state.ts` (the pure resolution
core) and `components/NavigationProvider.tsx` (its React binding, mounted
above the machine remount key). Three surfaces stay in sync: the URL, a
localStorage resume slot, and the UI.

### URL scheme

| Path | Meaning |
| --- | --- |
| `/` | resume the last machine/project/conversation from localStorage, or defaults |
| `/m/<machineId>` | that machine, default project + default conversation |
| `/m/<machineId>/p/<project>` | + project, default conversation (workspace-memory last, else most-recently modified) |
| `/m/<machineId>/p/<project>/s/<sessionId>` | that exact conversation |
| `/p/<project>[/s/<sessionId>]` | local machine, with the `/m` segment omitted |

`<project>` is the project-root absolute path, percent-encoded into one path
segment (`encodeURIComponent`, so `/` becomes `%2F`) — the same identifier
`?cwd=` and workspace-memory keys already used; there is no separate project
registry. Legacy `?machine=`/`?session=`/`?cwd=` query links (including
already-delivered notification URLs) still parse — `cwd` still wins over
`session` — and are canonicalized to the path form with one history
`replace` the first time they resolve.

### Resume

`omp-web:last-location` (`{v: 1, machine, project, session}`) is written to
localStorage exactly once, at the moment a navigation *settles* successfully.
A deeplink that fails validation never touches it — a broken shared link
can't clobber where you actually were. Precedence is decided once per
navigation: an explicit URL target always wins over resume, which always wins
over the built-in defaults (local machine, no project).

### History: push vs. replace

Explicit user selections — clicking a machine, project, or conversation in
the sidebar — call `navigate(target, { history: "push" })`: each one is a
real step in the back/forward stack, including a machine switch, which
pushes its bare `/m/<id>` immediately. System-driven corrections instead
`replace`: legacy query canonicalization, a machine switch's resolved
defaults filling in the bare URL it just pushed, and a session deletion
falling back to the project's welcome page — so back/forward never lands on
a URL the pipeline immediately has to rewrite (or on a session you just
deleted), and a machine switch never costs a second stack entry. A resume
settle (visiting `/`) never touches history at all — there is no URL to
correct it from, and rewriting one on every plain visit would be history
pollution. `popstate` is handled in exactly one place (`NavigationProvider`)
and always re-runs full resolution.

### Staged resolution and error taxonomy

A deeplink or resume target is resolved in stages — `machines` → `projects`
→ `session` — each waiting on its own data before selecting from it (no
"unknown id silently falls back to local" degrade). A target parsed from the
URL is validated *hard*: any failure shows a full-screen `AccessNotice`
naming the stage, with a call to action, never a silent fallback. A target
recovered from resume/defaults instead steps down *softly*, one level at a
time (stale session → the project's default conversation, stale project →
the machine's default project, stale/unreachable machine → local) — **except
offline, which is always a hard error even on resume**, since silently
dropping to local would hide that a whole machine went dark.

| Stage | Outcome | Notice variant |
| --- | --- | --- |
| machine | unknown id | `not-found` |
| machine | exists, not granted to you | `no-permission` (deliberately distinct from `not-found` — machine-id existence is not a secret on this fleet, see "Per-user machine grants" above) |
| machine | unreachable (network/proxy failure) | `offline` — always hard, with retry + "go local" |
| project | unknown, or not visible to you (with a `POST /api/cwd/validate` fallback so a fresh, zero-session project directory still opens) | `not-available` |
| session | unknown or hidden | `not-available` (uniform — never distinguishes "deleted" from "not visible to you", issue #7) |

A zero-session project deeplink is not an error: it opens the same blank
"start a new conversation here" state a fresh directory always would.

### What's out of scope

File-tab and right-panel state, per-machine roles, and the in-session branch
id (`leafId`) are never part of the URL — only machine, project, and
conversation are addressable and resumable.

## Limits, stated plainly

- **Absolute paths are machine-scoped.** A path like `/home/x/repo` means what
  it means *on the machine whose id is in the URL*. Never mix paths, session
  ids, or terminal ids across machines — that is what the per-machine remount
  and `machineStorageKey()` namespacing exist to prevent.
- **Terminal ids are valid only on their owning machine.** `POST
  /api/machines/<id>/api/terminals/<tid>/input` reaches the pty that machine
  spawned; the same id on another machine is a different terminal or a 404.
- **Keystrokes take one extra hop of latency.** Every proxied request —
  including terminal input and SSE event frames — travels browser → gateway →
  remote and back. Everything still streams (the proxy never buffers), but the
  hop is real.
- **No session syncing, no machine discovery.** The registry is a static list
  you maintain by hand; nothing detects machines, and a session is never moved
  or copied between machines. `/api/health` (authenticated, no side effects) is
  the probe for checking a remote's versions and verifying its stored
  credential in one round trip — `ompWebVersion` (this build's own
  `package.json` version) and `ompVersion` (the `@oh-my-pi/pi-coding-agent`
  **SDK** version that build was compiled against). `ompVersion` is not the
  standalone `omp` CLI binary that may also be installed on that host: omp-web
  embeds the SDK in-process and never shells out to the CLI, so the two can
  differ and that is expected, not drift.
