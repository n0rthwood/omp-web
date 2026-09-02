# Fleet deployment runbook

Operator runbook for the concrete six-host omp-web fleet behind the gateway
at 172.30.3.123. This is a deployment/ops document — for the fleet gateway's
API and proxy design, see [fleet.md](./fleet.md).

## Topology

| IP | Hostname | Role | Branch | Port | Bind |
| --- | --- | --- | --- | --- | --- |
| 172.30.3.123 | (gateway) | `omp-web.service`, existing install | — | 5010 | — |
| 172.30.3.250 | joysort-ai-server | remote | `main` | 5010 | `0.0.0.0` |
| 172.30.3.24 | joysort24 | remote | `main` | 5010 | `0.0.0.0` |
| 172.30.3.109 | joysort109 | remote | `main` | 5010 | `0.0.0.0` |
| 172.30.3.202 | gpu-dev | remote | `main` | 5010 | `0.0.0.0` |
| 172.30.3.39 | joysort39 | remote | `main` | 5010 | `0.0.0.0` |
| 172.30.3.110 | joysort110 | remote | `main` | 5010 | `0.0.0.0` |

`joysort110`'s box hostname is `training2` (it had a pre-existing omp install
with session history; `agent.db`/`sessions/` were preserved when it joined the
fleet on 2026-08-19 — only the binary and configs were refreshed).

Every remote runs as a `systemd --user omp-web.service` unit, with the app
tree at `~/omp/ompweb` on that host kept current by the `omp-web` apt
package (see [Apt upgrade](#day-2-operations) below) rather than a manual
git build. The fleet feature was developed on `feature/omp2-fleet-gateway`,
which merged into `main` and was then deleted; hosts provisioned during
that window were repointed to `main` before the apt package existed.

**Never restart, stop, or reconfigure `omp-web.service` on 172.30.3.123** from
a session running on it — it hosts the session itself.

## Per-host layout

On every remote:

- Checkout: `~/omp/ompweb`
- Env file: `~/omp/ops/env/5010.env`, mode `600`, exactly three keys:
  ```
  OMP_WEB_HOSTNAME=<LAN IP>
  OMP_WEB_PASSWORD=<unique per host>
  OMP_WEB_TERMINALS=1
  ```
- Unit: `~/.config/systemd/user/omp-web.service`

On the gateway (172.30.3.123):

- Each remote's password is mirrored at `~/omp/ops/env/fleet/<IP>.env`, mode
  `600` — the operator's copy, and the source used to register that machine
  with the gateway. This file is never printed and never committed.

## The systemd unit

Full unit, `~/.config/systemd/user/omp-web.service` on each remote (`<IP>` is
that host's own LAN address):

```ini
[Unit]
Description=omp-web

[Service]
Type=simple
WorkingDirectory=/home/joysort/omp/ompweb
EnvironmentFile=/home/joysort/omp/ops/env/5010.env
Environment=PATH=/home/joysort/.bun/bin:/home/joysort/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/joysort/.bun/bin/bun --bun /home/joysort/omp/ompweb/node_modules/next/dist/bin/next start -H 0.0.0.0 -p 5010
Restart=always
KillSignal=SIGTERM
KillMode=control-group

[Install]
WantedBy=default.target
```

**Why `KillSignal=SIGTERM` and not the systemd default:** omp-web's shutdown
handling distinguishes the two. `SIGINT` tears down every live `AgentSession`
on that host — every running agent turn, terminal, and unsaved session state
dies with it. `SIGTERM` is the safe signal for `systemctl --user restart` /
`stop`. Do not change this without checking the shutdown handler.

## Three traps that cost real time today

1. **Non-interactive SSH PATH excludes `~/.local/bin` and `~/.bun/bin` on most
   of these hosts**, because `.bashrc` guards them behind an interactive-shell
   check. Any `ssh host '...'` one-liner must use absolute paths
   (`/home/joysort/.bun/bin/bun`, not `bun`). This is exactly why the unit
   above has an explicit `Environment=PATH=...` line — a unit copied without
   it starts under systemd (which doesn't source `.bashrc` either) and then
   fails to find Bun.
2. **Check linger before you trust a reboot.** Run
   `loginctl show-user joysort -p Linger` on the host; if it says `Linger=no`,
   run `loginctl enable-linger joysort`. Without linger, the user service dies
   the moment the SSH session that started it ends, and never comes back after
   a reboot. This was off on `.24` and `.39` today.
3. **Never run `bun run dev`, `next build`, or `rm -rf .next` inside a
   directory that a live unit has as its `WorkingDirectory`.** On the gateway
   that directory is `/home/joysort/omp/ompweb`, and `omp-web.service` serves
   from the `.next` inside it. Deleting or rebuilding it does not disturb the
   running process immediately — it keeps serving HTML from its in-memory
   module graph — but that HTML references content-hashed chunk filenames from
   the build that is now gone. Next's JS chunk hashes are **not** reproducible
   across builds even from identical source, so the old chunks cannot be
   recreated: every browser page load then fails on its `main-app-*` and
   `webpack-*` assets until the service is restarted. Build in a git worktree
   instead (`git worktree add .worktrees/<name> <ref>` with `node_modules`
   symlinked), and if it has already happened, the only repair is a restart
   onto a complete `.next`. The apt package's own build happens in CI, not on
   any remote, so this trap now only bites a developer building locally in
   `~/omp/ompweb-feat` or a worktree — never during a routine fleet upgrade.

## Provider keys are single-sourced

`node_modules/@oh-my-pi/pi-utils/src/env.ts:199` eagerly parses
`$AGENT_DIR/.env` (`~/.omp/agent/.env`) at module init and only fills keys
that are **not already set** in the process environment. `~/.omp/agent/.env`
is therefore the one place provider keys belong on any host.

**Never duplicate a provider key into `~/omp/ops/env/5010.env`.** If it's set
there too, the systemd `EnvironmentFile` copy wins silently (it's already in
`Bun.env` before `~/.omp/agent/.env` is read), and rotating the key in the
normal place — `~/.omp/agent/.env` — then has no effect on that host. One host
had exactly this drift today; the duplicate was found and removed from its
`5010.env`.

## `OMP_WEB_ALLOWED_HOSTS` is unset on every remote — deliberately

`lib/request-security.ts` accepts any IP-literal `Host` header automatically,
and the fleet addresses every remote by IP, so no allow-list entry is needed
for the gateway to reach them. The allow-list does **exact hostname matching
with no wildcard support** — a value like `*.joysort.cn` would be dead
config, matching nothing. If a remote ever needs to be reached by DNS name
instead of IP, add that exact FQDN (not a wildcard) to that host's
`OMP_WEB_ALLOWED_HOSTS`.

## Auth

Every remote is on the `OMP_WEB_PASSWORD` migration bridge with the
hardcoded username `omp`. Register each on the gateway as:

```
authMode: "basic"
username: "omp"
token: <that remote's OMP_WEB_PASSWORD>
```

Terminals require a password on any non-loopback bind
(`lib/terminals/terminal-gate.ts`); every remote binds `0.0.0.0` and has
`OMP_WEB_PASSWORD` set, so this is already satisfied — terminals work over the
fleet without extra configuration.

## Security posture, stated plainly

Basic auth over plain HTTP on the LAN is base64, not encryption — readable by
anyone on the wire. This fleet is acceptable **only** because 172.30.3.0/24 is
a trusted VLAN. Anything that would cross an untrusted network (a different
site, a cloud host, a client on hostile Wi-Fi) needs TLS in front of it — a
reverse proxy terminating TLS, or a VPN — before Basic auth over it is
acceptable.

## Version reporting nuance

`GET /api/health` reports two version fields, and they are expected to
differ:

- `ompWebVersion` — this omp-web build's own `package.json` version.
- `ompVersion` — the `@oh-my-pi/pi-coding-agent` **SDK** version that this
  omp-web build was compiled against (read from
  `node_modules/@oh-my-pi/pi-coding-agent/package.json` at build time; today
  `17.3.0`). This is **not** the standalone `omp` CLI binary installed on that
  host (today `17.3.4`) — omp-web embeds the SDK in-process and never shells
  out to the CLI binary, so the two version numbers are independent and both
  being present and different is normal, not drift. The version-drift badge
  in the Machines UI (`MachinesConfig.tsx`) compares `ompVersion` /
  `ompWebVersion` **across machines**, not against the host's CLI.

## Gateway self-upgrade: `omp-web-restart-service`

### The problem

The gateway's `omp-web.service` unit sets `KillMode=control-group`, so
`systemctl --user restart omp-web` sends `SIGTERM` to every process in that
cgroup — including any shell that issued the restart command from inside
it. A browser-driven agent session hosted by that very service (see the
warning under [Topology](#topology)) cannot reliably self-upgrade the
gateway this way: the restart command dies along with everything else
before it's guaranteed to complete.

The fix is a second, completely independent `systemd --user` unit —
`omp-web-restart-service` — with its own cgroup, started by systemd
directly rather than forked from any caller's shell. It exposes a minimal
loopback-only HTTP trigger that runs a fixed shell script **detached** (its
own session, `start_new_session=True`) so the triggering HTTP call can
return immediately (`202`) and the actual restart survives even though the
process that issued the call may die moments later when the real restart
lands. Any future host running agent sessions in-process for its own
omp-web instance (the "gateway" role) should get the same unit.

### Protocol

Source: [`ops/restart-service/server.py`](../ops/restart-service/server.py)
— Python 3 stdlib only (`http.server`, `subprocess`, `threading`), no
dependencies to install. Binds `127.0.0.1` only, port from
`RESTART_SERVICE_PORT` (gateway uses **8799**).

| Endpoint | Auth | Behavior |
| --- | --- | --- |
| `GET /health` | none | `200 ok` |
| `POST /run` | `X-Restart-Token` header must match `RESTART_SERVICE_TOKEN` | Missing/wrong token → `401`. A run already in flight → `409` (never starts a second concurrent run). Script file missing → `500`, daemon does not crash. Otherwise spawns `bash <script>` detached, stdout+stderr to a timestamped log under `RESTART_SERVICE_LOG_DIR`, and returns `202` with `{"status": "started", "run_id", "pid"}` immediately — before the script has necessarily finished, or even necessarily succeeded. |
| `GET /status` | none (read-only, loopback-only anyway) | JSON: `run_id`, `pid`, `running`, `exit_code`, `started_at`, `ended_at`, `log_path`, `log_tail` (last 50 lines) for the most recent run. |

This is intentionally a single fixed-script trigger, not a generic
multi-tenant task runner. It has no TLS and is never exposed off loopback.

### Install (gateway only, `172.30.3.123`, user `joysort`)

```
mkdir -p ~/omp/ops/env ~/omp/ops/scripts ~/omp/ops/logs/restart-service

TOKEN=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")
cat > ~/omp/ops/env/restart-service.env <<EOF
RESTART_SERVICE_TOKEN=$TOKEN
RESTART_SERVICE_PORT=8799
RESTART_SERVICE_SCRIPT=/home/joysort/omp/ops/scripts/restart-payload.sh
RESTART_SERVICE_LOG_DIR=/home/joysort/omp/ops/logs/restart-service
EOF
chmod 600 ~/omp/ops/env/restart-service.env
unset TOKEN

# The real self-upgrade recipe this service exists to run (see "Apt
# upgrade" under Day-2 operations below for interactive use):
cat > ~/omp/ops/scripts/restart-payload.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
sudo apt-get update
sudo apt-get install -y --only-upgrade omp-web
EOF
chmod +x ~/omp/ops/scripts/restart-payload.sh

mkdir -p ~/.config/systemd/user
cp ~/omp/ompweb/ops/restart-service/omp-web-restart-service.service \
   ~/.config/systemd/user/omp-web-restart-service.service

systemctl --user daemon-reload
systemctl --user enable --now omp-web-restart-service
curl 127.0.0.1:8799/health
```

Confirm it is loopback-only, not `0.0.0.0`/`*`:

```
ss -ltnp | grep 8799
```

### Triggering a real gateway self-upgrade

Run from **any** session (it does not need to be, and for the reason above
*should not need to be*, the session that dies with the restart):

```
TOKEN=$(grep -oP '(?<=^RESTART_SERVICE_TOKEN=).*' ~/omp/ops/env/restart-service.env)
curl -s -X POST -H "X-Restart-Token: $TOKEN" http://127.0.0.1:8799/run
unset TOKEN
```

This returns `202` immediately. The gateway's `omp-web.service` restarts
partway through the script; if you triggered this from a session hosted by
`omp-web.service` itself, **that session dies at that point** — this is
expected, not a failure. From a **new** session (a fresh terminal, or a new
browser-driven agent session once the gateway is back), poll:

```
curl -s http://127.0.0.1:8799/status
```

until `running` is `false`, then check `exit_code` (`0` = success) and
`log_tail` for the `apt-get update`/`apt-get install` output.

### Verifying the loop without touching the live service

Never point `RESTART_SERVICE_SCRIPT` at anything real to test the daemon
itself. Swap the env file to a harmless throwaway script (sleeps briefly,
touches a marker file), `systemctl --user restart
omp-web-restart-service` (safe — it is not `omp-web.service`), drive the
full `401` → `202` → `409` → `GET /status` (`running: false`, `exit_code:
0`) loop against it, confirm the marker file, then point
`RESTART_SERVICE_SCRIPT` back at the real
`~/omp/ops/scripts/restart-payload.sh` and restart
`omp-web-restart-service` once more. `omp-web.service`'s own PID/uptime
must be unchanged before and after this whole exercise.

## Day-2 operations

**Apt upgrade (redeploy a remote)** (run on that host, or `ssh <host> '...'`
with absolute paths per trap #1):

```
sudo apt-get update && sudo apt-get install -y --only-upgrade omp-web
```

`~/omp/ompweb` stays the same git checkout it always was — the package
overlays it via `sync_app`'s non-deleting tar-pipe (`debian/postinst`), it
does not replace it with a fresh clone. A dirty `git status` there right
after an upgrade is that overlay, not uncommitted work — never
`git add`/`git commit` it.

**One host at a time, active-session hosts last.** The upgrade's `postinst`
restarts `omp-web.service` (same `KillMode=control-group` cgroup-wide
`SIGTERM` as a manual restart), which tears down every `AgentSession`
running in that host's process — live agent turns, terminals, and unsaved
session state on that host all die at the moment of restart. On the
gateway specifically, trigger the upgrade through
[`omp-web-restart-service`](#gateway-self-upgrade-omp-web-restart-service)
instead of running `apt-get install` directly from a session hosted by the
very service being upgraded — same reasoning as the git-pull recipe this
replaced.

**Never target `omp-web=0.3.9` explicitly.** That version's `ensure_env()`
(the step that materializes `node_modules` for a release) omits copying
`patches/` into the freshly created env dir, so
`bun install --frozen-lockfile` dies with "Couldn't find patch file" and
`dpkg` is left half-configured. Fixed in `0.3.10` (per `debian/changelog`);
`0.5.0` is a version-number-only relabel of `0.3.10`, carrying no further
code changes. A plain `apt-get install --only-upgrade omp-web` always
resolves to the highest available Candidate, so this only matters if
someone manually pins a version with `=<version>`.

**Tail logs:**

```
journalctl --user -u omp-web -f
```

**Check status:**

```
systemctl --user status omp-web
```

**Rotate a machine's password:**

1. On the remote, edit `~/omp/ops/env/5010.env`, change `OMP_WEB_PASSWORD=`,
   save (mode stays `600`).
2. `systemctl --user restart omp-web` on that remote.
3. On the gateway, update your operator copy at
   `~/omp/ops/env/fleet/<IP>.env` to match.
4. `PATCH /api/machines/<id>` on the gateway with the new `token`. The
   credential is bound to the `baseUrl` it was saved for by design — if you
   are also changing the machine's `baseUrl`, the gateway requires the
   credential to be re-entered in the same request; it will not silently
   carry an old token to a new origin.

## Adding a new host

Prerequisites, in order:

1. Configure the apt source, copying from an already-provisioned host
   rather than re-authoring by hand:
   ```
   ssh joysort@<existing-host> 'cat /etc/apt/keyrings/joysort-archive-keyring.gpg' \
     | ssh joysort@<new-host> 'sudo tee /etc/apt/keyrings/joysort-archive-keyring.gpg > /dev/null'
   ssh joysort@<existing-host> 'cat /etc/apt/sources.list.d/joysort.sources' \
     | ssh joysort@<new-host> 'sudo tee /etc/apt/sources.list.d/joysort.sources > /dev/null'
   ssh joysort@<new-host> 'sudo apt-get update'
   ```
2. Check linger: `loginctl show-user joysort -p Linger` on the new host; if
   it says `Linger=no`, run `loginctl enable-linger joysort`.
   `debian/postinst` only enables linger when it creates the `joysort` user
   itself — an already-existing user is left untouched.

Then, on the new host:

```
sudo apt-get install -y omp-web
```

`debian/postinst`'s fresh-install path (it runs because no completion
marker exists yet on this host) does everything the steps below used to do
by hand: installs the bundled Bun runtime and the `omp` CLI if either is
missing, materializes `node_modules` for the release's `bun.lock`
(`ensure_env`), tar-overlays the app tree into `~/omp/ompweb` (`sync_app`),
generates a random `OMP_WEB_PASSWORD` and writes `~/omp/ops/env/5010.env`
(`seed_env_file`), seeds `~/.omp/agent/{.env,models.yml,config.yml}` from
the package's own sealed defaults (`seed_agent_dir`), writes the
`systemd --user` unit from the packaged template, and enables + starts
`omp-web.service`. There is no `git clone`, `bun install`, or
`bun run build` step on the host itself — those already happened in the CI
job that built the package.

Still manual after install:

- Real provider API keys in `~/.omp/agent/.env` beyond whatever the
  package's sealed defaults cover (see "Provider keys are single-sourced"
  above).
- Registering the host with the gateway (below) — the package has no
  knowledge of the fleet gateway.

Verify locally on the new host, then from the gateway (see below), then:

- Copy its generated password
  (`grep OMP_WEB_PASSWORD ~/omp/ops/env/5010.env` on the new host) to
  `~/omp/ops/env/fleet/<IP>.env` on the gateway, mode `600`.
- Register it: `POST /api/machines` on the gateway with
  `{"name": "<hostname>", "baseUrl": "http://<IP>:5010", "authMode": "basic", "username": "omp", "token": "<password>"}`
  (see [fleet.md](./fleet.md) for the full field reference).

## Verification commands

From the gateway, confirm a remote enforces auth and accepts the fleet
credential (401 unauthenticated, 200 with credential — do not paste the
password directly into a command line; read it from the 600-mode file):

```
curl -s -o /dev/null -w '%{http_code}\n' "http://<IP>:5010/api/health"

OMP_WEB_PASSWORD=$(grep -oP '(?<=^OMP_WEB_PASSWORD=).*' ~/omp/ops/env/fleet/<IP>.env)
curl -s -o /dev/null -w '%{http_code}\n' -u "omp:${OMP_WEB_PASSWORD}" "http://<IP>:5010/api/health"
unset OMP_WEB_PASSWORD
```

Once the machine is registered on the gateway, confirm the proxy actually
reaches the right box — the `hostname` field must match the box you intended,
not another machine or the gateway itself:

```
curl -s http://127.0.0.1:5010/api/machines/<id>/api/health | jq .hostname
```
