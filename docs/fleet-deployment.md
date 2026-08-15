# Fleet deployment runbook

Operator runbook for the concrete five-host omp-web fleet behind the gateway
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

Every remote runs as a `systemd --user omp-web.service` unit, checked out from
`~/omp/ompweb` on that host, built from `main`. The fleet feature was developed
on `feature/omp2-fleet-gateway`, which merged into `main` and was then deleted;
hosts provisioned during that window were repointed to `main`.

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

## Four traps that cost real time today

1. **Non-interactive SSH PATH excludes `~/.local/bin` and `~/.bun/bin` on most
   of these hosts**, because `.bashrc` guards them behind an interactive-shell
   check. Any `ssh host '...'` one-liner must use absolute paths
   (`/home/joysort/.bun/bin/bun`, not `bun`). This is exactly why the unit
   above has an explicit `Environment=PATH=...` line — a unit copied without
   it starts under systemd (which doesn't source `.bashrc` either) and then
   fails to find Bun.
2. **`package.json`'s `build` script calls bare `bun`.** Running
   `bun run build` over SSH — even when you invoked the outer `bun` by
   absolute path — needs `PATH=$HOME/.bun/bin:$PATH` exported for that one
   command, or the nested `bun` invocation fails to resolve.
3. **Check linger before you trust a reboot.** Run
   `loginctl show-user joysort -p Linger` on the host; if it says `Linger=no`,
   run `loginctl enable-linger joysort`. Without linger, the user service dies
   the moment the SSH session that started it ends, and never comes back after
   a reboot. This was off on `.24` and `.39` today.
4. **Never run `bun run dev`, `next build`, or `rm -rf .next` inside a
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
   onto a complete `.next`.

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

## Day-2 operations

**Redeploy a remote** (run on that host, or `ssh <host> '...'` with absolute
paths per trap #1):

```
cd ~/omp/ompweb && git fetch origin && git checkout main && git pull && ~/.bun/bin/bun install && PATH=$HOME/.bun/bin:$PATH bun run build && systemctl --user restart omp-web
```

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

## Adding a sixth host

Prerequisites, in order:

1. Bun installed for the `joysort` user (`~/.bun/bin/bun` present).
2. `loginctl enable-linger joysort` if `loginctl show-user joysort -p Linger`
   says `no`.
3. `omp` CLI binary and `~/.omp/agent/{.env,models.yml,config.yml}` in place,
   each `600` where they carry secrets — copy from an already-provisioned
   host (e.g. `scp` from 172.30.3.123) rather than re-authoring by hand.
4. GitHub SSH access for that user (deploy key or personal key with repo
   access) so `git clone git@github.com:n0rthwood/omp-web.git` succeeds.

Then, on the new host:

```
git clone git@github.com:n0rthwood/omp-web.git ~/omp/ompweb
cd ~/omp/ompweb
~/.bun/bin/bun install
PATH=$HOME/.bun/bin:$PATH bun run build

mkdir -p ~/omp/ops/env
cat > ~/omp/ops/env/5010.env <<'EOF'
OMP_WEB_HOSTNAME=<this host's LAN IP>
OMP_WEB_PASSWORD=<generate a new unique password>
OMP_WEB_TERMINALS=1
EOF
chmod 600 ~/omp/ops/env/5010.env

mkdir -p ~/.config/systemd/user
# create ~/.config/systemd/user/omp-web.service using the unit template above,
# with <IP> replaced by this host's LAN address

systemctl --user daemon-reload
systemctl --user enable --now omp-web
```

Verify locally on the new host, then from the gateway (see below), then:

- Copy its password to `~/omp/ops/env/fleet/<IP>.env` on the gateway, mode
  `600`.
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
