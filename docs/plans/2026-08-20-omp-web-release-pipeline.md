# omp-web Debian/apt Release Pipeline Implementation Plan (Revised)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revision note (2026-08-20):** This document replaces the original two-comment plan posted at
> https://github.com/n0rthwood/omp-web/issues/25#issuecomment-5359312710 and
> https://github.com/n0rthwood/omp-web/issues/25#issuecomment-5359313065, which received a **NO-GO**
> verdict at https://github.com/n0rthwood/omp-web/issues/25#issuecomment-5361386083 (the "addendum"),
> subsequently amended by https://github.com/n0rthwood/omp-web/issues/25#issuecomment-5362604376 (owner
> inputs resolved). Every task below incorporates both comments. Superseded choices from the original
> plan — bare `v*` tags, a GitHub-Release-asset step, `JOYSORT_PAT`, runner-local `cloudflare.conf`/GPG
> files as the CI credential source, manually pre-created `joysort` in the LXC test, "unit file exists"
> as the fresh/upgrade signal, `omp` as optional tooling, and byte-identical `.202` config parity — are
> removed, not left alongside the new choices.

**Goal:** Ship omp-web as a `.deb` (`apt install omp-web`), built and published by a GitHub Actions
workflow on a self-hosted runner dedicated to `n0rthwood/omp-web`, installed as a per-user
`systemd --user` service that a bare host can bootstrap from scratch (creating its own `joysort`
account), and that an already-deployed fleet host can upgrade in place — crash-safely, with its full
`~/.omp/agent` state, unit, env file, and operator files preserved — without a GitHub Release object,
without a `GH_PAT`, and without any release credential living only on the build host's disk.

**Architecture:** `build-deb.sh` orchestrates `dpkg-buildpackage` (debhelper compat 13) to assemble
`/opt/omp-web/{current,runtime,config,secrets,systemd}` inside the `.deb`. `debian/preinst` performs
read-only prerequisite checks only (disk space, an existing incompatible install, whether `omp` is
already on the target user's PATH) — the bundled `omp`/`bun` binaries are not unpacked yet when preinst
runs, so nothing is installed there. `debian/postinst` decides fresh-install-or-resume vs.
upgrade-only by the presence of a dedicated completion marker
(`~/.local/state/omp-web/install.complete`), **not** by unit-file presence — every fresh-install
sub-step is idempotent, so an interrupted install resumes safely on the next `dpkg --configure`/
`apt --reinstall` instead of erroring or duplicating state. `joysort` is the unconditional default
target account (never `$SUDO_USER`); postinst creates it if absent. `omp` is a mandatory host CLI,
probed on the target user's full login PATH, preserved if found, installed to `~/.local/bin/omp` if
absent, with a namespaced `systemd` drop-in (`omp-web.service.d/10-omp-path.conf`) as the only
mechanism allowed to correct an **existing, otherwise-untouched** unit's `PATH=`. Provider API tokens
travel inside the `.deb` XOR-"sealed" (`tools/xor-secrets.py`) — obfuscation, not encryption; see
**Security notes**. `.github/workflows/release.yml` runs on a self-hosted runner registered to
`n0rthwood/omp-web`, always builds and uploads an artifact, and — **only on an `omp-web-vX.Y.Z` tag
push, never on `workflow_dispatch`** — calls `JoySort/joysort-release-tools`'s
`update-apt-repo` composite action to publish to `https://repo.joysort.cc/apt` (codename `jammy`),
authenticated with real GitHub Actions vars/secrets (`R2_ACCOUNT_ID`, `R2_BUCKET`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `REPO_GPG_PRIVATE_KEY`, `REPO_GPG_PASSPHRASE`) — never a
runner-local credential file, and never a `GH_PAT`. A fresh, no-`joysort`-user Ubuntu 22.04 LXC
container on `172.30.3.24` proves the whole install/upgrade/crash-recovery contract before any fleet
host is touched. Landing is a direct merge to `main` — no pull request, per standing project
preference.

**Tech Stack:** `dpkg-deb`/`dpkg-buildpackage`/debhelper 13 (verified on the runner:
`dpkg-buildpackage 1.21.1`, `debhelper 13.6ubuntu1`), Bash, Python 3 stdlib only
(`tools/xor-secrets.py`), Bun 1.3.14, `omp` 17.3.4, GitHub Actions
(`[self-hosted, Linux, X64, omp-web]`), `JoySort/joysort-release-tools`'s `update-apt-repo` action,
LXD/`snapd` for the disposable test container.

---

## File map

| Path | Role |
| --- | --- |
| `debian/control` | Source/binary package metadata, build/runtime `Depends` |
| `debian/changelog` | Version source of truth (`dpkg-parsechangelog`); tag `omp-web-vX.Y.Z` must equal the top entry's version |
| `debian/source/format` | `3.0 (native)` |
| `debian/rules` | debhelper build recipe: `bun install && bun run build`, then assembles `/opt/omp-web/*` |
| `debian/preinst` | Read-only prerequisite inspection only (disk space, existing install, existing `omp`) — installs nothing |
| `debian/postinst` | Marker-driven, idempotent fresh-install-or-resume vs. upgrade-only sync + restart; joysort-only account creation; `omp` PATH detection/install/drop-in |
| `debian/prerm` | Stops the user service on `apt remove` (not on upgrade) |
| `debian/postrm` | On `purge`, deletes `/opt/omp-web` only; never touches a user's `$HOME` |
| `build-deb.sh` | CI/dev entrypoint: fetches seed configs, seals secrets, runs `dpkg-buildpackage`, drops the `.deb` in `debian_dist/` |
| `release/seeds/fetch-seeds.sh` | Fetches `~/.omp/agent/{models,config}.yml` verbatim from `172.30.3.24` over SSH and appends the `agent-plan`/`volcengine-plan`/`xai` provider blocks |
| `release/seeds/assemble-secrets.sh` | Merges the owner-resolved local `omp-web-secrets.env.plain` (today: `XAI_API_KEY`, `OMP_WEB_PASSWORD` only) with the five provider keys already live on a fleet host, **without overwriting owner-set values and without ever printing a value** |
| `release/seeds/models.yml`, `release/seeds/config.yml` | Generated, gitignored — build-time output of `fetch-seeds.sh` |
| `release/seeds/omp-web-secrets.env.xorb64`, `release/seeds/omp-web-xor.key` | Generated, gitignored — build-time output of `tools/xor-secrets.py seal` |
| `release/systemd/omp-web.service` | Real fleet unit (verified verbatim against `172.30.3.24`), templated with `__HOME__` |
| `tools/xor-secrets.py` | `seal` / `merge` / `get` — the XOR obfuscation tool |
| `tools/test_xor_secrets.py` | `unittest` coverage for the roundtrip and the "existing key wins" merge rule |
| `tests/fixtures/bin/*` | Fake `useradd`/`getent`/`runuser`/`systemctl`/`loginctl`/`install`/`chown`/`hostname` used to run the real maintainer scripts against a scratch filesystem |
| `tests/run-postinst-fixture-tests.sh` | Runs `debian/preinst`, `debian/postinst`, `debian/prerm`, `debian/postrm` against isolated fixture roots — fresh install, idempotent re-run, crash-safe resume, upgrade non-destructiveness, PATH drop-in, purge safety |
| `.github/workflows/release.yml` | Self-hosted-runner workflow: build (always) → publish (tag pushes only) via `update-apt-repo` |
| `.gitignore` | Additions for `debian_dist/`, debhelper build litter, and generated `release/seeds/*` outputs |
| `release/lxc-test/ompweb-lxc-forward.service` | Root-level systemd unit on `172.30.3.24` forwarding `:22322→container:22` and `:5011→container:5010` |

---

## Design decisions

1. **Debian version stream is independent of `package.json`.** `package.json` (`0.2.9`) drives the
   existing npm publish workflow (`publish-npm.yml`, triggered on bare `v*`); the `.deb` gets its own
   version stream starting at `debian/changelog`'s `0.3.0`, no `-N` Debian revision (native package,
   `debian/source/format: 3.0 (native)`).
2. **Tag format is `omp-web-vX.Y.Z`, not bare `v*`.** `publish-npm.yml` already owns `v*` and validates
   against `package.json`; a bare `v*` release tag would collide with it. This is a hard requirement
   from https://github.com/n0rthwood/omp-web/issues/25#issuecomment-5361386083 §1.
3. **Production publish happens only on a tag push. `workflow_dispatch` never publishes.** The release
   workflow (Task 14) splits into a `build` job (runs on both a tag push and `workflow_dispatch`,
   always produces and uploads a `.deb` artifact) and a `publish` job that only runs when
   `github.ref_type == 'tag'`. A manual dispatch can never supersede or overwrite the apt repo's
   currently-published tagged package, because it never reaches the publish step at all — see
   addendum §1 ("A manual `workflow_dispatch` build must never be able to supersede or overwrite the
   apt repo's currently-published tagged production package").
4. **No GitHub Release object, no Release asset.** The tag is the trigger and version source only.
   Reconfirmed at https://github.com/n0rthwood/omp-web/issues/25#issuecomment-5362604376: "No GitHub
   Release object and no Release asset upload — reconfirmed per owner direction; publishing remains
   apt-repo-only."
5. **`/opt/omp-web/current` is the dpkg-owned reference copy; `$HOME/omp/ompweb` stays the systemd
   `WorkingDirectory`.** All six already-deployed fleet hosts run a unit whose
   `WorkingDirectory=/home/<user>/omp/ompweb` (verified verbatim on `172.30.3.24`, Task 3). "Reinstall/
   upgrade must not touch the service unit" is a hard constraint, so `postinst` overlays
   `/opt/omp-web/current/` onto `$HOME/omp/ompweb/` as the target user via a `tar -cf - | tar -xf -`
   pipe — **never `rsync --delete`** — on every install and every upgrade. A file removed between
   releases can remain stale under `$HOME/omp/ompweb/` until cleaned up separately; silently deleting
   `.git` or an operator-added untracked file under a live fleet host is worse than that, so `postinst`
   never runs `rm -rf`/`--delete` against `$HOME/omp/ompweb/`.
6. **CI publishing secrets and packaged runtime secrets are two disjoint categories, never
   conflated** (addendum §2):
   - **CI publishing credentials** (R2 + GPG signing key) live **only** as real GitHub Actions repo
     vars/secrets on `n0rthwood/omp-web` — `vars.R2_ACCOUNT_ID`, `vars.R2_BUCKET`,
     `secrets.R2_ACCESS_KEY_ID`, `secrets.R2_SECRET_ACCESS_KEY`, `secrets.REPO_GPG_PRIVATE_KEY`,
     `secrets.REPO_GPG_PASSPHRASE` — matching the canonical `/opt/workspace/joysort2026` pattern
     (verified against `joysort-desktop`'s and `jsfb`'s live workflows and
     `joysort-release-tools/.github/actions/update-apt-repo/action.yml`'s own `inputs:`). They are
     **never** read from a runner-local file at build/publish time — Task 17 provisions them once,
     from the runner-local credential files that already exist for other reasons, directly into the
     Actions secret store; after that, the workflow only ever reads `${{ secrets.* }}`/`${{ vars.* }}`.
   - **Packaged runtime secrets** (provider API tokens + default `OMP_WEB_PASSWORD`) remain
     XOR-obfuscated, ship inside the `.deb`, and are assembled from **local, owner-only input** — see
     Design decision 10.
   - **No `GH_PAT` of any kind is required or provisioned anywhere in this plan.** `grep -c GH_PAT
     .github/workflows/release.yml` is `0` (verified in Task 14 Step 3); no repo secret named
     `GH_PAT`/`JOYSORT_PAT` is created (Task 17 does not create one; Task 0's preflight explicitly
     asserts none exists).
7. **The canonical `update-apt-repo` composite action is used verbatim — never hand-rolled, never
   vendored.** Addendum §1 is explicit: "through the canonical composite action
   `JoySort/joysort-release-tools/.github/actions/update-apt-repo` — the same action every other
   canonical JoySort package uses. Do not hand-roll a separate publish script." `.github/workflows/
   release.yml`'s `publish` job references it directly:
   `uses: JoySort/joysort-release-tools/.github/actions/update-apt-repo@main`.
8. **Cross-repo access prerequisite for the canonical action (explicit, not a workaround).**
   `JoySort/joysort-release-tools` is a **private** repository owned by the `JoySort` organization;
   `n0rthwood/omp-web` is a **public** repository owned by the individual account `n0rthwood`
   (verified: `gh api repos/n0rthwood/omp-web --jq .private` → `false`;
   `gh api repos/JoySort/joysort-release-tools --jq .private` → `true`). GitHub's built-in
   `GITHUB_TOKEN` is always scoped to the single repository a workflow run belongs to and can never
   read a different repository, in the same org or a different one — this is a platform limitation,
   not a configuration gap, and is the reason the *original* plan needed `secrets.GH_PAT`. Owner
   direction (https://github.com/n0rthwood/omp-web/issues/25#issuecomment-5362604376) is that no PAT
   should be provisioned and that the workflow should use an "already-available GitHub Actions
   authentication mechanism" instead. GitHub does ship exactly one such mechanism for this situation —
   private-action sharing without any token
   (https://docs.github.com/en/actions/how-tos/reuse-automations/share-across-private-repositories) —
   but it is restricted to **private** consuming repositories ("Access is allowed only from private
   repositories" —
   https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository).
   Because `n0rthwood/omp-web` is public today, this mechanism does not yet apply. This plan therefore
   commits `.github/workflows/release.yml` referencing the canonical action exactly as required by
   Design decision 7, and states the **exact, minimal, zero-new-credential prerequisite** that makes it
   resolvable — see Task 15. No PAT, App token, vendored copy, or runner-local `git`/`gh` credential is
   introduced anywhere in this plan to work around it; the `publish` job will fail with "Unable to
   resolve action ... not found" until the prerequisite in Task 15 is satisfied, and this is called out
   explicitly rather than papered over.
9. **Fresh vs. upgrade is decided by a dedicated completion marker
   (`~/.local/state/omp-web/install.complete`), never by unit-file presence** (addendum §7). Marker
   absent → run every fresh-install step; every one of those steps is individually idempotent (guarded
   by an existence check or safe to re-apply) **and every step that creates a first-install file
   (the unit, the env file, the merged `~/.omp/agent/.env`, the marker itself) writes via a
   same-directory `mktemp` + `mv`/`os.replace` atomic rename, never a direct redirect into the final
   path** — so a process killed mid-write leaves only a stray temp file behind, never a truncated
   target that a marker-absent resume would misidentify as "already done" and skip. Re-running the
   full sequence after an interruption — whether nothing had happened yet or the unit/env file/agent
   dir were partially seeded — converges to the same fully-provisioned, correctly-marked state with no
   duplicate or corrupted output. The marker is written only as the very last step, using the same
   `mktemp` + `mv` pattern, so a process killed at any point before that leaves the marker absent and
   the next run safely resumes rather than misclassifying a partial install as either "fresh" or
   "upgrade".
10. **`joysort` is the unconditional default target account — never `$SUDO_USER`** (addendum §3).
    `resolve_target_user()` only ever returns `$OMP_WEB_TARGET_USER` (an explicit test/override escape
    hatch) or the literal string `joysort`. If `joysort` does not exist, `postinst` creates it
    (`useradd -m -s /bin/bash joysort`, which on Debian/Ubuntu also creates the matching private group
    and home directory by default) and enables linger, unconditionally, as part of the fresh-install
    path — never conditionally on whether the invoking `sudo` user happens to be someone else.
11. **`omp` is a mandatory host CLI, not optional tooling** (addendum §8). `postinst` probes
    `command -v omp` as the target login user (full effective PATH, not one hardcoded location). Found
    → preserved untouched, its directory recorded for PATH purposes. Absent → the bundled binary is
    installed to `~/.local/bin/omp` **in postinst, never preinst** — the package payload containing the
    bundled binary is not unpacked yet when preinst runs. A **fresh** unit's `PATH=` line is built from
    the resolved bun + omp directories directly. An **already-existing** unit is never rewritten; if its
    `PATH=` line covers neither the actual resolved `omp` directory nor `~/.local/bin`, a namespaced
    drop-in `omp-web.service.d/10-omp-path.conf` supplies a corrected `PATH=` — the only mechanism
    allowed to fix PATH on an already-deployed host. Reinstall preserves an already-correct unit and an
    already-created drop-in without regenerating or duplicating either.
12. **A restart interrupting a live in-process `AgentSession` during reinstall/upgrade is accepted, not
    worked around** (addendum §6). omp-web runs sessions in-process; this is architectural.
13. **Full-state preservation is proven by checksum/sentinel, not by "unit and env file unchanged"
    alone** (addendum §6). The reinstall verification (Task 23) seeds a realistic `~/.omp/agent` tree
    covering credentials, `models.yml`/`config.yml`, SQLite DB/WAL/SHM, session `.jsonl`, registries,
    skills/plugins/extensions/memories/uploads/terminal state — plus operator-added files under
    `~/omp/ompweb` — captures checksums before a reinstall, and diffs after.
14. **Parity with `172.30.3.202` is structural/operational, not byte-identical config content**
    (addendum §5). `.202` has five provider API-key names and no `XAI_API_KEY`; this plan's expanded
    provider set (`agent-plan`, `volcengine-plan`, `xai`) is the new baseline going forward. Task 22
    asserts user/paths/unit-shape/env-shape/auth/port/permissions/state-layout parity, never a literal
    `diff` against `.202`'s current `models.yml`/`config.yml`.
15. **The fresh-LXC proof starts with no `joysort` user and no manual pre-provisioning** (addendum §4).
    Task 19 explicitly asserts `id joysort` fails before `apt install omp-web`, and the package itself
    creates the account — no `useradd`, no `git clone`, no direct `dpkg -i`, no ad hoc runtime download
    outside what `postinst` performs.
16. **Bundled runtimes, not network installs.** `/opt/omp-web/runtime/{bun,omp}` are the runner's own
    `~/.bun/bin/bun` and `~/.local/bin/omp` binaries, copied verbatim into the package at build time.
17. **`models.yml`/`config.yml` seeds are fetched live, not hand-authored**, via
    `release/seeds/fetch-seeds.sh` against `172.30.3.24` at every build — see Task 5.
18. **`apiKey:` holds the env var *name*, not a literal secret**, confirmed against the real,
    currently-loaded `~/.omp/agent/models.yml` on both `172.30.3.123` and `172.30.3.24`.
19. **Maintainer scripts run as root, then drop to the target user via `runuser -l`.** The target user
    is resolved once and reused for every step.
20. **Direct merge to `main`, no pull request**, per standing project preference (memory: "NEVER create
    a pull request unless the user explicitly asks for one... merge it directly into main"). Task 20.

---

## Security notes — read before Task 15

**The XOR "sealing" of provider API tokens is obfuscation, not encryption.** `tools/xor-secrets.py
seal` XORs the plaintext `KEY=VALUE` secrets file against a randomly generated key, base64-encodes the
ciphertext, and ships **both** the ciphertext (`/opt/omp-web/secrets/secrets.env.xorb64`) **and** the
key (`/opt/omp-web/secrets/xor.key`) inside the same `.deb`. **Anyone who can read the `.deb` file, or
read `/opt/omp-web/secrets/` on any host it is installed on, can trivially recover every plaintext
token.** There is deliberately no password, KMS, or separate secret channel — the owner explicitly
required this design (addendum §2B: "the plan's XOR ciphertext+key-in-the-same-artifact design is
accepted as-is").

This is acceptable **only** because:
- The apt repository (`repo.joysort.cc`) and every host that installs from it are JoySort-controlled
  infrastructure, not public distribution.
- The tokens involved (`DEEPSEEK_API_KEY`, `AGENT_PLAN_API_KEY`, `VOLCENGINE_PLAN_API_KEY`,
  `BAILIAN_CLI_API_KEY`, `ZHIPU_API_KEY`, `XAI_API_KEY`) are provider API keys already present in
  plaintext in `~/.omp/agent/.env` (mode `0600`) on every fleet host today — the `.deb` does not lower
  the bar below "any root/owner on a fleet host can already read these," it only adds "anyone who
  obtains the `.deb` file itself" to that set.
- `OMP_WEB_PASSWORD` (the Basic-auth password seeded on fresh installs) is likewise recoverable from
  the `.deb` by design — a shared bootstrap default, not a secret meant to resist a determined reader
  of the package.

**No secret value is ever printed, logged, or committed by this plan.** Every command that reads a
plaintext value (`xor-secrets.py get`, the SSH `grep` in `assemble-secrets.sh`) writes it straight into
a file with `>`/`>>`, never to stdout in a way a human or CI log would see it. Verification steps in
this plan check **key names and counts only** (`cut -d= -f1`), never values.

**Rotation procedure**: edit `~/joysort-release-credential/omp-web-secrets.env.plain` on the runner,
delete the stale `release/seeds/omp-web-secrets.env.xorb64` / `release/seeds/omp-web-xor.key`, re-run
`./build-deb.sh` (which reseals with a **freshly random** key), publish a new package version.
Rotation does **not** require rewriting any already-installed host's `~/.omp/agent/.env`, because
`postinst merge` only fills in *missing* keys.

---

## Task 0: Runner & GitHub Actions preflight verification

**Files:** none (verification only).

- [ ] **Step 1: Confirm the toolchain versions this plan's commands assume**

Run on `172.30.3.123` as `joysort` (the machine this plan is being authored/implemented on):

```bash
dpkg-buildpackage --version | head -1
dpkg -l debhelper | tail -1
bun --version
omp --version
python3 --version
```

Expected: `Debian dpkg-buildpackage version 1.21.1.`, a `debhelper` row showing `13.6ubuntu1` or newer,
`1.3.14` or newer, `omp/17.3.4` or newer, `Python 3.10.12` or newer.

- [ ] **Step 2: Confirm SSH reachability to the seed/provider-key host**

```bash
ssh -o BatchMode=yes -o ConnectTimeout=5 joysort@172.30.3.24 'echo REACHABLE'
```

Expected: `REACHABLE`.

- [ ] **Step 3: Confirm today's local secrets file has exactly the two owner-resolved keys**

```bash
cut -d= -f1 /home/joysort/joysort-release-credential/omp-web-secrets.env.plain | sort
stat -c '%a %U:%G' /home/joysort/joysort-release-credential /home/joysort/joysort-release-credential/omp-web-secrets.env.plain
```

Expected key list:
```
OMP_WEB_PASSWORD
XAI_API_KEY
```
Expected permissions: `700 joysort:joysort` for the directory, `600 joysort:joysort` for the file.
Task 18 assembles the remaining five provider keys into this same file without touching these two.

- [ ] **Step 4: Confirm no `GH_PAT`/`JOYSORT_PAT` repo secret exists**

```bash
gh secret list --repo n0rthwood/omp-web 2>&1 | grep -iE 'GH_PAT|JOYSORT_PAT' && echo FOUND_UNEXPECTED_PAT || echo NO_PAT_SECRET_OK
```

Expected: `NO_PAT_SECRET_OK`. Re-run after Task 14 against the committed `.github/workflows/
release.yml` too: `grep -c GH_PAT .github/workflows/release.yml` must print `0`.

- [ ] **Step 5: Confirm `n0rthwood/omp-web` and `JoySort/joysort-release-tools` visibility**
  (grounds Design decision 8)

```bash
gh api repos/n0rthwood/omp-web --jq '{full_name, private}'
gh api repos/JoySort/joysort-release-tools --jq '{full_name, private}'
```

Expected: `{"full_name":"n0rthwood/omp-web","private":false}` and
`{"full_name":"JoySort/joysort-release-tools","private":true}`. If `n0rthwood/omp-web`'s `private`
value has changed to `true` by the time this runs, re-read Task 15 before starting it — its
prerequisite may already be satisfied.

---

## Task 1: Confirm the tracking issue and worktree are already in place

Issue #25 and this worktree/branch already exist — this task only confirms that, so a fresh
implementer picking up this plan doesn't redo Task 1 from the original document.

**Files:** none (verification only).

- [ ] **Step 1: Confirm the issue**

```bash
gh issue view 25 --repo n0rthwood/omp-web --json number,title,state --jq '{number, title, state}'
```

Expected: `{"number":25,"title":"Debian/apt release pipeline for omp-web","state":"OPEN"}`.

- [ ] **Step 2: Confirm the worktree and branch**

```bash
git rev-parse --abbrev-ref HEAD
git status --porcelain
```

Run from `/home/joysort/omp/ompweb/.worktrees/omp25-debian-apt-release-pipeline`. Expected:
`feature/omp25-debian-apt-release-pipeline`, and no uncommitted changes outside this plan document
(this revision is the first commit of new content on this branch — see Task 20).

All remaining tasks run inside this worktree.

---

## Task 2: `debian/control`, `debian/changelog`, `debian/source/format`

**Files:**
- Create: `debian/control`
- Create: `debian/changelog`
- Create: `debian/source/format`

- [ ] **Step 1: Write `debian/control`**

```
Source: omp-web
Section: web
Priority: optional
Maintainer: JoySort Release Bot <release@joysort.cc>
Build-Depends: debhelper-compat (= 13), rsync
Standards-Version: 4.6.2
Homepage: https://github.com/n0rthwood/omp-web
Rules-Requires-Root: no

Package: omp-web
Architecture: amd64
Depends: ${misc:Depends}, python3, systemd
Description: Web view for the omp (oh-my-pi) coding agent CLI
 omp-web serves a Next.js UI over the oh-my-pi coding-agent SDK. This
 package installs a self-contained application bundle under /opt/omp-web,
 provisions a per-user systemd --user service (creating the joysort
 account if it does not already exist) on first install, and on upgrade
 only re-syncs the application code and restarts that service — the unit
 file, its environment file, and the user's
 ~/.omp/agent/{.env,config.yml,models.yml} are never touched after the
 first install.
```

- [ ] **Step 2: Write `debian/changelog`**

```
omp-web (0.3.0) jammy; urgency=medium

  * Initial Debian packaging: build-deb.sh, debhelper rules, XOR-obfuscated
    provider-secret seeding, crash-safe fresh-install-or-resume postinst,
    mandatory omp CLI PATH handling, and systemd --user service
    installation (closes #25).

 -- JoySort Release Bot <release@joysort.cc>  Thu, 20 Aug 2026 12:00:00 +0000
```

- [ ] **Step 3: Write `debian/source/format`**

```
3.0 (native)
```

- [ ] **Step 4: Verify the changelog parses**

```bash
dpkg-parsechangelog -S Version
dpkg-parsechangelog -S Source
```

Expected: `0.3.0` then `omp-web`.

- [ ] **Step 5: Commit**

```bash
git add debian/control debian/changelog debian/source/format
git commit -m "chore: add debian/control, changelog, source format (refs #25)"
```

---

## Task 3: `release/systemd/omp-web.service`

**Files:**
- Create: `release/systemd/omp-web.service`

- [ ] **Step 1: Fetch the live unit for comparison**

```bash
ssh joysort@172.30.3.24 'cat ~/.config/systemd/user/omp-web.service'
```

Expected (re-verified 2026-08-20 during this revision):

```ini
[Unit]
Description=omp-web production (port 5010, authenticated, Terminal tab enabled)
Documentation=https://github.com/n0rthwood/omp-web
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/joysort/omp/ompweb

EnvironmentFile=/home/joysort/omp/ops/env/5010.env
Environment=NODE_ENV=production
Environment=PORT=5010
Environment=PATH=/home/joysort/.bun/bin:/home/joysort/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=SHELL=/bin/bash

ExecStart=/home/joysort/.bun/bin/bun --bun /home/joysort/omp/ompweb/node_modules/next/dist/bin/next start -H 0.0.0.0 -p 5010

Restart=always
RestartSec=2

KillSignal=SIGTERM
TimeoutStopSec=20
KillMode=control-group

[Install]
WantedBy=default.target
```

- [ ] **Step 2: Write `release/systemd/omp-web.service`** (identical, `/home/joysort` replaced by
  `__HOME__`)

```ini
[Unit]
Description=omp-web production (port 5010, authenticated, Terminal tab enabled)
Documentation=https://github.com/n0rthwood/omp-web
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=__HOME__/omp/ompweb

EnvironmentFile=__HOME__/omp/ops/env/5010.env
Environment=NODE_ENV=production
Environment=PORT=5010
Environment=PATH=__HOME__/.bun/bin:__HOME__/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=SHELL=/bin/bash

ExecStart=__HOME__/.bun/bin/bun --bun __HOME__/omp/ompweb/node_modules/next/dist/bin/next start -H 0.0.0.0 -p 5010

Restart=always
RestartSec=2

KillSignal=SIGTERM
TimeoutStopSec=20
KillMode=control-group

[Install]
WantedBy=default.target
```

- [ ] **Step 3: Verify substitution round-trips exactly**

```bash
sed 's|__HOME__|/home/joysort|g' release/systemd/omp-web.service \
  | diff - <(ssh joysort@172.30.3.24 'cat ~/.config/systemd/user/omp-web.service')
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add release/systemd/omp-web.service
git commit -m "chore: add templated systemd --user unit for omp-web (refs #25)"
```

---

## Task 4: `tools/xor-secrets.py` (TDD)

**Files:**
- Create: `tools/test_xor_secrets.py`
- Create: `tools/xor-secrets.py`

- [ ] **Step 1: Write the failing test**

```python
# tools/test_xor_secrets.py
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "xor-secrets.py"


def run(*args):
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        check=False,
    )


class XorSecretsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def test_seal_then_get_roundtrips_a_value(self):
        plain = self.dir / "secrets.env.plain"
        plain.write_text("DEEPSEEK_API_KEY=sk-test-123\nXAI_API_KEY=xai-test-456\n")
        cipher = self.dir / "secrets.env.xorb64"
        key = self.dir / "xor.key"

        sealed = run("seal", "--plain", str(plain), "--out-cipher", str(cipher), "--out-key", str(key))
        self.assertEqual(sealed.returncode, 0, sealed.stderr)
        self.assertNotIn(b"sk-test-123", cipher.read_bytes())

        got = run("get", "--cipher", str(cipher), "--key", str(key), "--var", "DEEPSEEK_API_KEY")
        self.assertEqual(got.returncode, 0, got.stderr)
        self.assertEqual(got.stdout.strip(), "sk-test-123")

    def test_merge_keeps_existing_value_and_appends_new_keys(self):
        plain = self.dir / "secrets.env.plain"
        plain.write_text("DEEPSEEK_API_KEY=sealed-value\nZHIPU_API_KEY=sealed-zhipu\n")
        cipher = self.dir / "secrets.env.xorb64"
        key = self.dir / "xor.key"
        run("seal", "--plain", str(plain), "--out-cipher", str(cipher), "--out-key", str(key))

        target = self.dir / ".env"
        target.write_text("DEEPSEEK_API_KEY=already-here\n")

        merged = run("merge", "--cipher", str(cipher), "--key", str(key), "--target", str(target))
        self.assertEqual(merged.returncode, 0, merged.stderr)

        text = target.read_text()
        self.assertIn("DEEPSEEK_API_KEY=already-here", text)
        self.assertNotIn("sealed-value", text)
        self.assertIn("ZHIPU_API_KEY=sealed-zhipu", text)

    def test_merge_skip_var_excludes_a_key(self):
        plain = self.dir / "secrets.env.plain"
        plain.write_text("DEEPSEEK_API_KEY=sealed-value\nOMP_WEB_PASSWORD=default-pw\n")
        cipher = self.dir / "secrets.env.xorb64"
        key = self.dir / "xor.key"
        run("seal", "--plain", str(plain), "--out-cipher", str(cipher), "--out-key", str(key))

        target = self.dir / ".env"
        merged = run(
            "merge", "--cipher", str(cipher), "--key", str(key),
            "--target", str(target), "--skip-var", "OMP_WEB_PASSWORD",
        )
        self.assertEqual(merged.returncode, 0, merged.stderr)

        text = target.read_text()
        self.assertIn("DEEPSEEK_API_KEY=sealed-value", text)
        self.assertNotIn("OMP_WEB_PASSWORD", text)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
python3 -m unittest tools.test_xor_secrets -v
```

Expected: `FileNotFoundError` — `tools/xor-secrets.py` does not exist yet.

- [ ] **Step 3: Write `tools/xor-secrets.py`**

```python
#!/usr/bin/env python3
"""XOR-obfuscate/deobfuscate the omp-web release provider-secrets bundle.

This is OBFUSCATION, not encryption: the ciphertext and the key both ship
inside the .deb, so anyone who can read the package (or the installed
/opt/omp-web/secrets directory) can recover the plaintext. See
docs/plans/2026-08-20-omp-web-release-pipeline.md, "Security notes".
"""

from __future__ import annotations

import argparse
import base64
import os
import sys
import tempfile
from pathlib import Path


def _xor(data: bytes, key: bytes) -> bytes:
    if not key:
        raise ValueError("key must not be empty")
    return bytes(b ^ key[i % len(key)] for i, b in enumerate(data))


def cmd_seal(args: argparse.Namespace) -> None:
    plain_path = Path(args.plain)
    plaintext = plain_path.read_bytes()
    key = os.urandom(args.key_bytes)
    ciphertext = _xor(plaintext, key)

    out_cipher = Path(args.out_cipher)
    out_key = Path(args.out_key)
    out_cipher.parent.mkdir(parents=True, exist_ok=True)
    out_key.parent.mkdir(parents=True, exist_ok=True)
    out_cipher.write_text(base64.b64encode(ciphertext).decode("ascii") + "\n")
    out_key.write_bytes(key)
    print(f"sealed {plain_path} -> {out_cipher} ({len(plaintext)} bytes, {args.key_bytes}-byte key)")


def _decrypt(cipher_path: Path, key_path: Path) -> str:
    ciphertext = base64.b64decode(cipher_path.read_text().strip())
    key = key_path.read_bytes()
    return _xor(ciphertext, key).decode("utf-8")


def _parse_env(text: str) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        pairs.append((key.strip(), value))
    return pairs


def cmd_merge(args: argparse.Namespace) -> None:
    plaintext = _decrypt(Path(args.cipher), Path(args.key))
    secrets = dict(_parse_env(plaintext))
    for skip in args.skip_var:
        secrets.pop(skip, None)

    target_path = Path(args.target)
    target_path.parent.mkdir(parents=True, exist_ok=True)
    existing_text = target_path.read_text() if target_path.exists() else ""
    existing_keys = {k for k, _ in _parse_env(existing_text)}

    to_append = [(k, v) for k, v in secrets.items() if k not in existing_keys]
    if not to_append:
        print(f"{target_path}: all {len(secrets)} sealed keys already present, nothing to merge")
        return

    lines = existing_text.splitlines()
    if lines and lines[-1].strip():
        lines.append("")
    lines.append("# added by tools/xor-secrets.py merge (existing keys always win)")
    for key, value in to_append:
        lines.append(f"{key}={value}")
    fd, tmp_name = tempfile.mkstemp(dir=str(target_path.parent), prefix=f".{target_path.name}.")
    with os.fdopen(fd, "w") as f:
        f.write("\n".join(lines) + "\n")
    os.replace(tmp_name, target_path)  # same-directory rename is atomic
    os.chmod(target_path, 0o600)
    print(f"{target_path}: merged {len(to_append)} key(s): {', '.join(k for k, _ in to_append)}")


def cmd_get(args: argparse.Namespace) -> None:
    plaintext = _decrypt(Path(args.cipher), Path(args.key))
    secrets = dict(_parse_env(plaintext))
    if args.var not in secrets:
        print(f"error: {args.var} not present in sealed bundle", file=sys.stderr)
        sys.exit(1)
    print(secrets[args.var])


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    seal = sub.add_parser("seal", help="XOR-obfuscate a plaintext KEY=VALUE env file")
    seal.add_argument("--plain", required=True)
    seal.add_argument("--out-cipher", required=True)
    seal.add_argument("--out-key", required=True)
    seal.add_argument("--key-bytes", type=int, default=4096)
    seal.set_defaults(func=cmd_seal)

    merge = sub.add_parser("merge", help="Decrypt and merge sealed keys into a target .env file")
    merge.add_argument("--cipher", required=True)
    merge.add_argument("--key", required=True)
    merge.add_argument("--target", required=True)
    merge.add_argument("--skip-var", action="append", default=[])
    merge.set_defaults(func=cmd_merge)

    get = sub.add_parser("get", help="Print one decrypted key's value to stdout")
    get.add_argument("--cipher", required=True)
    get.add_argument("--key", required=True)
    get.add_argument("--var", required=True)
    get.set_defaults(func=cmd_get)

    return parser


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run the tests again and confirm they pass**

```bash
python3 -m unittest tools.test_xor_secrets -v
```

Expected:

```
test_merge_keeps_existing_value_and_appends_new_keys (tools.test_xor_secrets.XorSecretsTest) ... ok
test_merge_skip_var_excludes_a_key (tools.test_xor_secrets.XorSecretsTest) ... ok
test_seal_then_get_roundtrips_a_value (tools.test_xor_secrets.XorSecretsTest) ... ok

----------------------------------------------------------------------
Ran 3 tests in 0.142s

OK
```

- [ ] **Step 5: Commit**

```bash
chmod +x tools/xor-secrets.py
git add tools/xor-secrets.py tools/test_xor_secrets.py
git commit -m "feat: add tools/xor-secrets.py seal/merge/get with unit tests (refs #25)"
```

---

## Task 5: `release/seeds/fetch-seeds.sh`

**Files:**
- Create: `release/seeds/fetch-seeds.sh`

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
set -euo pipefail
HOST="${1:-joysort@172.30.3.24}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" 'cat ~/.omp/agent/config.yml' > "$DIR/config.yml"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" 'cat ~/.omp/agent/models.yml' > "$DIR/models.yml"

cat >> "$DIR/models.yml" <<'YAML'

  # --- appended by release/seeds/fetch-seeds.sh: fleet-standard providers ---
  # This expanded set (agent-plan, volcengine-plan, xai) is the new baseline
  # seed going forward — it supersedes any older host's current models.yml
  # snapshot; see docs/plans/2026-08-20-omp-web-release-pipeline.md, Design
  # decision 14 (structural, not byte-identical, .202 parity).
  agent-plan:
    baseUrl: https://ark.cn-beijing.volces.com/api/plan/v3
    api: openai-completions
    apiKey: AGENT_PLAN_API_KEY
    authHeader: true
    models:
      - id: ark-code-latest
        name: ark-code-latest
      - id: doubao-seed-2-0-code-preview-260215
        name: doubao-seed-2-0-code-preview-260215
        input: [text, image]
        contextWindow: 262144
        maxTokens: 4096
      - id: doubao-seed-2-0-lite-260215
        name: doubao-seed-2-0-lite-260215
        input: [text, image]
        contextWindow: 262144
        maxTokens: 4096
      - id: doubao-seed-2-0-mini-260215
        name: doubao-seed-2-0-mini-260215
        input: [text, image]
        contextWindow: 262144
        maxTokens: 4096
      - id: doubao-seed-2-0-pro-260215
        name: doubao-seed-2-0-pro-260215
        input: [text, image]
        contextWindow: 262144
        maxTokens: 4096
      - id: glm-5.1
        name: glm-5.1
      - id: glm-5.2
        name: glm-5.2
      - id: kimi-k2.6
        name: kimi-k2.6
      - id: kimi-k2.7-code
        name: kimi-k2.7-code
      - id: minimax-m2.7
        name: minimax-m2.7
      - id: minimax-m3
        name: minimax-m3
  volcengine-plan:
    baseUrl: https://ark.cn-beijing.volces.com/api/coding/v3
    api: openai-completions
    apiKey: VOLCENGINE_PLAN_API_KEY
    authHeader: true
    models:
      - id: ark-code-latest
        name: ark-code-latest
        input: [text, image]
        contextWindow: 256000
        maxTokens: 4096
      - id: doubao-seed-2.0-code
        name: doubao-seed-2.0-code
        input: [text, image]
        contextWindow: 256000
        maxTokens: 4096
      - id: doubao-seed-2.0-lite
        name: doubao-seed-2.0-lite
        input: [text, image]
        contextWindow: 256000
        maxTokens: 4096
      - id: doubao-seed-2.0-pro
        name: doubao-seed-2.0-pro
        input: [text, image]
        contextWindow: 256000
        maxTokens: 4096
      - id: doubao-seed-code
        name: doubao-seed-code
        input: [text, image]
        contextWindow: 256000
        maxTokens: 4096
      - id: glm-4.7
        name: glm-4.7
        input: [text]
        contextWindow: 200000
        maxTokens: 4096
      - id: glm-5.1
        name: glm-5.1
        input: [text]
        contextWindow: 200000
        maxTokens: 4096
      - id: kimi-k2.5
        name: kimi-k2.5
        input: [text, image]
        contextWindow: 256000
        maxTokens: 4096
      - id: kimi-k2.6
        name: kimi-k2.6
        input: [text, image]
        contextWindow: 256000
        maxTokens: 4096
      - id: minimax-m2.7
        name: minimax-m2.7
        input: [text]
        contextWindow: 200000
        maxTokens: 4096
  xai:
    baseUrl: https://api.x.ai/v1
    api: openai-completions
    apiKey: XAI_API_KEY
    authHeader: true
    models:
      - id: grok-code-fast-1
        name: grok-code-fast-1
YAML

echo "==> Wrote $DIR/config.yml and $DIR/models.yml"
```

Unlike the original plan, the `xai:` block is **not** commented out: `XAI_API_KEY` is now a resolved,
owner-provided value (Task 18), so the expanded baseline (Design decision 14) ships active from the
first build.

- [ ] **Step 2: Run it and inspect the output**

```bash
chmod +x release/seeds/fetch-seeds.sh
./release/seeds/fetch-seeds.sh joysort@172.30.3.24
wc -l release/seeds/config.yml release/seeds/models.yml
grep -c '^  [a-z-]*:$' release/seeds/models.yml
```

Expected: `==> Wrote .../release/seeds/config.yml and .../release/seeds/models.yml`; `models.yml`
provider count of 3 (`deepseek`, `bailian-cli`, `zhipu-coding-plan`) before the appended block, 6 after
(`agent-plan`, `volcengine-plan`, `xai` added).

- [ ] **Step 3: Commit the script only** (outputs are gitignored in Task 12)

```bash
git add release/seeds/fetch-seeds.sh
git commit -m "feat: add release/seeds/fetch-seeds.sh with active xai baseline (refs #25)"
```

---

## Task 6: Packaging maintainer-script fixture-test harness (TDD, before implementation)

This is the "explicit packaging tests that run maintainer scripts against isolated fixture roots"
required before any LXC work. It runs the **real** `debian/preinst`/`postinst`/`prerm`/`postrm` against
a scratch filesystem using fake `useradd`/`getent`/`runuser`/`systemctl`/`loginctl`/`install`/`chown`/
`hostname` on `PATH` — no root, no real user creation, no LXC.

**Files:**
- Create: `tests/fixtures/bin/useradd`
- Create: `tests/fixtures/bin/getent`
- Create: `tests/fixtures/bin/runuser`
- Create: `tests/fixtures/bin/systemctl`
- Create: `tests/fixtures/bin/loginctl`
- Create: `tests/fixtures/bin/install`
- Create: `tests/fixtures/bin/chown`
- Create: `tests/fixtures/bin/hostname`
- Create: `tests/run-postinst-fixture-tests.sh`

- [ ] **Step 1: Write the fake commands**

```bash
# tests/fixtures/bin/useradd
#!/bin/bash
# useradd -m -s /bin/bash NAME — records a synthetic passwd entry under
# OMP_WEB_TEST_ROOT instead of touching the real system.
NAME="${@: -1}"
HOME_DIR="${OMP_WEB_TEST_ROOT}/home/$NAME"
mkdir -p "$HOME_DIR"
PASSWD_FILE="${OMP_WEB_TEST_ROOT}/etc/passwd.fixture"
mkdir -p "$(dirname "$PASSWD_FILE")"
grep -q "^$NAME:" "$PASSWD_FILE" 2>/dev/null || \
  echo "$NAME:x:9999:9999:fixture:$HOME_DIR:/bin/bash" >> "$PASSWD_FILE"
```

```bash
# tests/fixtures/bin/getent
#!/bin/bash
# getent passwd NAME
if [ "$1" = "passwd" ] && [ -n "${OMP_WEB_TEST_ROOT:-}" ]; then
  PASSWD_FILE="${OMP_WEB_TEST_ROOT}/etc/passwd.fixture"
  [ -f "$PASSWD_FILE" ] && grep "^$2:" "$PASSWD_FILE"
  exit $?
fi
exec /usr/bin/getent "$@"
```

```bash
# tests/fixtures/bin/runuser
#!/bin/bash
# runuser -l NAME -c CMD — the fixture "target user" isn't a real OS
# account, so execute CMD as the current (real) user with HOME repointed
# at the fixture home directory and the fixture bin/ still first on PATH.
shift # drop -l
NAME="$1"; shift
shift # drop -c
CMD="$1"
HOME_DIR="$(getent passwd "$NAME" | cut -d: -f6)"
HOME="$HOME_DIR" bash -c "$CMD"
```

```bash
# tests/fixtures/bin/systemctl
#!/bin/bash
# systemctl --user SUBCOMMAND [unit] — records invocations; is-active
# reflects a state file the test can pre-seed so postinst's
# active/inactive branching is exercisable.
LOG="${OMP_WEB_TEST_ROOT}/systemctl.log"
echo "$*" >> "$LOG"
STATE_FILE="${OMP_WEB_TEST_ROOT}/omp-web.service.state"
case "$2" in
  is-active)
    [ -f "$STATE_FILE" ] && [ "$(cat "$STATE_FILE")" = active ] && exit 0
    exit 3
    ;;
  enable|start|restart)
    echo active > "$STATE_FILE"
    ;;
  stop)
    echo inactive > "$STATE_FILE"
    ;;
  daemon-reload) ;;
esac
exit 0
```

```bash
# tests/fixtures/bin/loginctl
#!/bin/bash
exit 0
```

```bash
# tests/fixtures/bin/install
#!/bin/bash
# Strips -o/-g owner flags (the fixture user isn't a real OS account) and
# delegates everything else to the real coreutils install.
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    -o|-g) shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
exec /usr/bin/install "${args[@]}"
```

```bash
# tests/fixtures/bin/chown
#!/bin/bash
# No-op — the fixture user isn't a real OS account, so real chown would fail.
exit 0
```

```bash
# tests/fixtures/bin/hostname
#!/bin/bash
[ "$1" = "-I" ] && { echo "10.0.0.99 "; exit 0; }
exec /usr/bin/hostname "$@"
```

- [ ] **Step 2: Make the fakes executable**

```bash
chmod +x tests/fixtures/bin/*
```

- [ ] **Step 3: Write `tests/run-postinst-fixture-tests.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"

FAIL=0
assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "ok - $desc"
  else
    echo "FAIL - $desc: expected [$expected] got [$actual]"
    FAIL=1
  fi
}
assert_file_exists() {
  local desc="$1" path="$2"
  if [ -f "$path" ]; then
    echo "ok - $desc"
  else
    echo "FAIL - $desc: missing $path"
    FAIL=1
  fi
}

new_fixture_root() { mktemp -d "${TMPDIR:-/tmp}/omp-web-fixture.XXXXXX"; }

build_fake_payload() {
  local root="$1"
  mkdir -p "$root/opt/omp-web/current/tools" "$root/opt/omp-web/runtime" \
    "$root/opt/omp-web/config" "$root/opt/omp-web/secrets" "$root/opt/omp-web/systemd"
  cp "$REPO_ROOT/tools/xor-secrets.py" "$root/opt/omp-web/current/tools/"
  printf '#!/bin/bash\necho bun-fake "$@"\n' > "$root/opt/omp-web/runtime/bun"
  printf '#!/bin/bash\necho omp-fake "$@"\n' > "$root/opt/omp-web/runtime/omp"
  chmod +x "$root/opt/omp-web/runtime/bun" "$root/opt/omp-web/runtime/omp"
  echo "1.3.14" > "$root/opt/omp-web/runtime/bun.version"
  echo "17.3.4" > "$root/opt/omp-web/runtime/omp.version"
  printf 'modelRoles:\n  plan: {}\n' > "$root/opt/omp-web/config/config.yml.default"
  printf 'providers:\n  deepseek: {}\n' > "$root/opt/omp-web/config/models.yml.default"
  cp "$REPO_ROOT/release/systemd/omp-web.service" "$root/opt/omp-web/systemd/omp-web.service"

  mkdir -p "$root/secrets-plain"
  cat > "$root/secrets-plain/secrets.env.plain" <<'EOF'
DEEPSEEK_API_KEY=fixture-deepseek
XAI_API_KEY=fixture-xai
OMP_WEB_PASSWORD=fixture-password
EOF
  python3 "$REPO_ROOT/tools/xor-secrets.py" seal \
    --plain "$root/secrets-plain/secrets.env.plain" \
    --out-cipher "$root/opt/omp-web/secrets/secrets.env.xorb64" \
    --out-key "$root/opt/omp-web/secrets/xor.key"
}

run_preinst() {
  local root="$1"
  OMP_WEB_TEST_ROOT="$root" PATH="$HERE/fixtures/bin:$PATH" \
    bash "$REPO_ROOT/debian/preinst" install
}

run_postinst() {
  local root="$1"; shift
  OMP_WEB_TEST_ROOT="$root" PATH="$HERE/fixtures/bin:$PATH" \
    bash "$REPO_ROOT/debian/postinst" configure "$@"
}

# --- Test 1: preinst is read-only and never installs the payload ---
ROOT0="$(new_fixture_root)"
build_fake_payload "$ROOT0"
run_preinst "$ROOT0"
OMP_INSTALLED_BY_PREINST="$( [ -f "$ROOT0/home/joysort/.local/bin/omp" ] && echo 1 || echo 0 )"
assert_eq "preinst: never installs the bundled omp binary" "0" "$OMP_INSTALLED_BY_PREINST"

# --- Test 2: fresh install provisions everything and writes the marker ---
ROOT1="$(new_fixture_root)"
build_fake_payload "$ROOT1"
run_postinst "$ROOT1"
HOME1="$ROOT1/home/joysort"
assert_file_exists "fresh install: marker written" "$HOME1/.local/state/omp-web/install.complete"
assert_file_exists "fresh install: unit written" "$HOME1/.config/systemd/user/omp-web.service"
assert_file_exists "fresh install: env file written" "$HOME1/omp/ops/env/5010.env"
assert_file_exists "fresh install: agent .env written" "$HOME1/.omp/agent/.env"
DEEPSEEK_VAL="$(grep '^DEEPSEEK_API_KEY=' "$HOME1/.omp/agent/.env" | cut -d= -f2)"
assert_eq "fresh install: provider secret merged" "fixture-deepseek" "$DEEPSEEK_VAL"
PW_COUNT="$(grep -c OMP_WEB_PASSWORD "$HOME1/.omp/agent/.env" || true)"
assert_eq "fresh install: password kept out of agent .env" "0" "$PW_COUNT"

# --- Test 3: re-running fresh install is idempotent ---
BEFORE_LINES="$(wc -l < "$HOME1/.omp/agent/.env")"
run_postinst "$ROOT1"
AFTER_LINES="$(wc -l < "$HOME1/.omp/agent/.env")"
assert_eq "idempotent re-run: agent .env unchanged" "$BEFORE_LINES" "$AFTER_LINES"
UNIT_SUM_BEFORE="$(sha256sum "$HOME1/.config/systemd/user/omp-web.service" | cut -d' ' -f1)"
run_postinst "$ROOT1"
UNIT_SUM_AFTER="$(sha256sum "$HOME1/.config/systemd/user/omp-web.service" | cut -d' ' -f1)"
assert_eq "idempotent re-run: unit unchanged" "$UNIT_SUM_BEFORE" "$UNIT_SUM_AFTER"

# --- Test 4: crash-safe resume — a kill mid-write leaves only a stray
# temp file (write_fresh_unit's mktemp target), never a truncated final
# unit — confirms the atomic-write model actually prevents the corrupt
# resume scenario, then confirms resume still completes fully. ---
ROOT3="$(new_fixture_root)"
build_fake_payload "$ROOT3"
PATH="$HERE/fixtures/bin:$PATH" OMP_WEB_TEST_ROOT="$ROOT3" \
  "$HERE/fixtures/bin/useradd" -m -s /bin/bash joysort
HOME3="$ROOT3/home/joysort"
mkdir -p "$HOME3/.config/systemd/user"
echo "leftover-temp-from-a-killed-write_fresh_unit" > "$HOME3/.config/systemd/user/.omp-web.service.ab12cd"
FINAL_UNIT_PRESENT_BEFORE="$( [ -f "$HOME3/.config/systemd/user/omp-web.service" ] && echo 1 || echo 0 )"
assert_eq "crash-safe: killed mktemp write left no final unit file" "0" "$FINAL_UNIT_PRESENT_BEFORE"
MARKER_PRESENT_BEFORE="$( [ -f "$HOME3/.local/state/omp-web/install.complete" ] && echo 1 || echo 0 )"
assert_eq "crash-safe: no marker before resume" "0" "$MARKER_PRESENT_BEFORE"
run_postinst "$ROOT3"
assert_file_exists "crash-safe: resume completes and writes marker" "$HOME3/.local/state/omp-web/install.complete"
assert_file_exists "crash-safe: resume writes a real final unit file" "$HOME3/.config/systemd/user/omp-web.service"
UNIT_HAS_SECTION="$(grep -c '^\[Unit\]' "$HOME3/.config/systemd/user/omp-web.service" || true)"
assert_eq "crash-safe: resumed unit is well-formed, not the stray temp content" "1" "$UNIT_HAS_SECTION"
assert_file_exists "crash-safe: resume still seeds env file" "$HOME3/omp/ops/env/5010.env"
assert_file_exists "crash-safe: resume still seeds agent .env" "$HOME3/.omp/agent/.env"

# --- Test 5: upgrade path never rewrites the unit or env file, preserves operator files ---
ROOT4="$(new_fixture_root)"
build_fake_payload "$ROOT4"
run_postinst "$ROOT4"
HOME4="$ROOT4/home/joysort"
echo "operator-customized-value" >> "$HOME4/omp/ops/env/5010.env"
UNIT_SUM_BEFORE4="$(sha256sum "$HOME4/.config/systemd/user/omp-web.service" | cut -d' ' -f1)"
ENV_SUM_BEFORE4="$(sha256sum "$HOME4/omp/ops/env/5010.env" | cut -d' ' -f1)"
mkdir -p "$HOME4/omp/ompweb"
echo "operator-added-file" > "$HOME4/omp/ompweb/operator-note.txt"
run_postinst "$ROOT4"
UNIT_SUM_AFTER4="$(sha256sum "$HOME4/.config/systemd/user/omp-web.service" | cut -d' ' -f1)"
ENV_SUM_AFTER4="$(sha256sum "$HOME4/omp/ops/env/5010.env" | cut -d' ' -f1)"
assert_eq "upgrade: unit byte-identical" "$UNIT_SUM_BEFORE4" "$UNIT_SUM_AFTER4"
assert_eq "upgrade: env file byte-identical" "$ENV_SUM_BEFORE4" "$ENV_SUM_AFTER4"
assert_file_exists "upgrade: non-destructive overlay preserves operator file" "$HOME4/omp/ompweb/operator-note.txt"

# --- Test 6: PATH drop-in only created when the existing unit's PATH misses omp/bun ---
ROOT5="$(new_fixture_root)"
build_fake_payload "$ROOT5"
run_postinst "$ROOT5"
HOME5="$ROOT5/home/joysort"
sed -i 's|^Environment=PATH=.*|Environment=PATH=/usr/local/bin:/usr/bin:/bin|' \
  "$HOME5/.config/systemd/user/omp-web.service"
run_postinst "$ROOT5"
DROPIN="$HOME5/.config/systemd/user/omp-web.service.d/10-omp-path.conf"
assert_file_exists "drop-in created when unit PATH lacks omp/bun dirs" "$DROPIN"
DROPIN_SUM_BEFORE5="$(sha256sum "$DROPIN" | cut -d' ' -f1)"
run_postinst "$ROOT5"
DROPIN_SUM_AFTER5="$(sha256sum "$DROPIN" | cut -d' ' -f1)"
assert_eq "drop-in: idempotent re-run does not duplicate/rewrite" "$DROPIN_SUM_BEFORE5" "$DROPIN_SUM_AFTER5"

# --- Test 7: prerm stops the service on remove; postrm purge only deletes /opt/omp-web ---
ROOT6="$(new_fixture_root)"
build_fake_payload "$ROOT6"
run_postinst "$ROOT6"
HOME6="$ROOT6/home/joysort"
OMP_WEB_TEST_ROOT="$ROOT6" PATH="$HERE/fixtures/bin:$PATH" bash "$REPO_ROOT/debian/prerm" remove
assert_eq "prerm: service stopped on remove" "inactive" "$(cat "$ROOT6/omp-web.service.state")"
OMP_WEB_TEST_ROOT="$ROOT6" PATH="$HERE/fixtures/bin:$PATH" bash "$REPO_ROOT/debian/postrm" purge
PKG_DIR_GONE="$( [ -d "$ROOT6/opt/omp-web" ] && echo 1 || echo 0 )"
AGENT_DIR_KEPT="$( [ -d "$HOME6/.omp/agent" ] && echo 1 || echo 0 )"
APP_DIR_KEPT="$( [ -d "$HOME6/omp/ompweb" ] && echo 1 || echo 0 )"
assert_eq "postrm purge: package tree removed" "0" "$PKG_DIR_GONE"
assert_eq "postrm purge: user's agent dir untouched" "1" "$AGENT_DIR_KEPT"
assert_eq "postrm purge: user's app dir untouched" "1" "$APP_DIR_KEPT"

echo "---"
if [ "$FAIL" = "1" ]; then
  echo "FIXTURE TESTS FAILED"
  exit 1
fi
echo "ALL FIXTURE TESTS PASSED"
```

- [ ] **Step 4: Make it executable and run it now, before `debian/preinst`/`postinst` exist**

```bash
chmod +x tests/run-postinst-fixture-tests.sh
./tests/run-postinst-fixture-tests.sh
```

Expected: fails immediately — `bash: .../debian/preinst: No such file or directory` — confirming the
harness genuinely exercises the real scripts rather than trivially passing. Tasks 7–8 make it pass.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures tests/run-postinst-fixture-tests.sh
git commit -m "test: add isolated fixture-root harness for maintainer scripts (refs #25)"
```

---

## Task 7: `debian/preinst`

**Files:**
- Create: `debian/preinst`

- [ ] **Step 1: Write the file**

```bash
#!/bin/bash
# debian/preinst — omp-web
#
# Read-only prerequisite checks ONLY. The bundled omp/bun binaries are not
# yet unpacked when preinst runs (dpkg unpacks the new package's files
# between preinst and postinst) — installing the bundled omp CLI happens
# in postinst, never here. See
# docs/plans/2026-08-20-omp-web-release-pipeline.md, Design decision 11.
set -e

ROOT_PREFIX="${OMP_WEB_TEST_ROOT:-}"

case "$1" in
  install|upgrade)
    if [ -d "${ROOT_PREFIX}/opt/omp-web/current" ] && [ ! -w "${ROOT_PREFIX}/opt/omp-web/current" ]; then
      echo "omp-web: ${ROOT_PREFIX}/opt/omp-web/current exists but is not writable by root; aborting." >&2
      exit 1
    fi

    AVAIL_KB="$(df --output=avail -k "${ROOT_PREFIX:-/opt}" 2>/dev/null | tail -1 | tr -d ' ')"
    if [ -n "$AVAIL_KB" ] && [ "$AVAIL_KB" -lt 512000 ]; then
      echo "omp-web: less than 500MB free (${AVAIL_KB}KB) at ${ROOT_PREFIX:-/opt} — the package payload plus a fresh ~/omp/ompweb copy needs more headroom; aborting." >&2
      exit 1
    fi

    TARGET_USER="${OMP_WEB_TARGET_USER:-joysort}"
    if getent passwd "$TARGET_USER" >/dev/null 2>&1; then
      EXISTING_OMP="$(runuser -l "$TARGET_USER" -c 'command -v omp' 2>/dev/null || true)"
      if [ -n "$EXISTING_OMP" ]; then
        echo "omp-web: preinst check — $TARGET_USER already has omp at $EXISTING_OMP; postinst will preserve it." >&2
      else
        echo "omp-web: preinst check — $TARGET_USER has no omp on PATH yet; postinst will install the bundled one." >&2
      fi
    else
      echo "omp-web: preinst check — account '$TARGET_USER' does not exist yet; postinst will create it." >&2
    fi
    ;;
esac

exit 0
```

- [ ] **Step 2: Syntax-check**

```bash
bash -n debian/preinst && echo PREINST_SYNTAX_OK
chmod 0755 debian/preinst
```

Expected: `PREINST_SYNTAX_OK`.

- [ ] **Step 3: Run the fixture harness — Test 1 (preinst is read-only) now passes**

```bash
./tests/run-postinst-fixture-tests.sh 2>&1 | grep -E 'preinst|FAIL|No such file'
```

Expected: `ok - preinst: never installs the bundled omp binary`, followed by a failure referencing
`debian/postinst` (Task 8 makes that pass).

- [ ] **Step 4: Commit**

```bash
git add debian/preinst
git commit -m "feat: add debian/preinst with read-only prerequisite checks only (refs #25)"
```

---

## Task 8: `debian/postinst`

**Files:**
- Create: `debian/postinst`

- [ ] **Step 1: Write the file**

```bash
#!/bin/bash
# debian/postinst — omp-web
#
# Fresh install / resumed-after-interruption (completion marker absent):
# creates the joysort account if absent (never $SUDO_USER — Design
# decision 10), resolves/installs omp, writes the unit + env file +
# ~/.omp/agent seeds + merged secrets (every sub-step idempotent, so a
# resumed interrupted install converges safely instead of erroring or
# duplicating state — Design decision 9), enables the service, then writes
# the completion marker as the LAST step via mktemp+mv (atomic rename).
#
# Upgrade/reinstall (marker present): NEVER touches the unit, env file, or
# anything under ~/.omp/agent/. Only overlays /opt/omp-web/current onto
# ~/omp/ompweb via a non-destructive tar-pipe, refreshes bundled runtimes
# if stale, restarts the service if it was running (restart interrupting a
# live in-process AgentSession is accepted — Design decision 12), and
# creates/refreshes a PATH drop-in only if the existing unit's PATH does
# not already cover the resolved omp directory (Design decision 11).
set -e

ROOT_PREFIX="${OMP_WEB_TEST_ROOT:-}"
OMP_WEB_SRC="${ROOT_PREFIX}/opt/omp-web/current"
RUNTIME_DIR="${ROOT_PREFIX}/opt/omp-web/runtime"
CONFIG_DIR="${ROOT_PREFIX}/opt/omp-web/config"
SECRETS_DIR="${ROOT_PREFIX}/opt/omp-web/secrets"
SYSTEMD_SEED="${ROOT_PREFIX}/opt/omp-web/systemd/omp-web.service"

resolve_target_user() {
  if [ -n "${OMP_WEB_TARGET_USER:-}" ]; then
    echo "$OMP_WEB_TARGET_USER"
  else
    echo joysort
  fi
}

case "$1" in
  configure)
    TARGET_USER="$(resolve_target_user)"

    if ! getent passwd "$TARGET_USER" >/dev/null 2>&1; then
      echo "omp-web: account '$TARGET_USER' does not exist; creating it (unconditional fresh-install default, never \$SUDO_USER — Design decision 10)" >&2
      useradd -m -s /bin/bash "$TARGET_USER"
      loginctl enable-linger "$TARGET_USER" 2>/dev/null || true
    fi

    TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
    if [ -z "$TARGET_HOME" ] || [ ! -d "$TARGET_HOME" ]; then
      echo "omp-web: no home directory for user $TARGET_USER after creation" >&2
      exit 1
    fi

    run_as_target() { runuser -l "$TARGET_USER" -c "$1"; }

    MARKER_DIR="$TARGET_HOME/.local/state/omp-web"
    MARKER="$MARKER_DIR/install.complete"
    UNIT_PATH="$TARGET_HOME/.config/systemd/user/omp-web.service"
    DEST="$TARGET_HOME/omp/ompweb"
    DROPIN_DIR="$TARGET_HOME/.config/systemd/user/omp-web.service.d"
    DROPIN="$DROPIN_DIR/10-omp-path.conf"

    sync_bun() {
      BUN_BIN="$TARGET_HOME/.bun/bin/bun"
      if [ ! -x "$BUN_BIN" ]; then
        install -D -m 0755 -o "$TARGET_USER" -g "$TARGET_USER" \
          "$RUNTIME_DIR/bun" "$BUN_BIN"
        echo "omp-web: installed bun $(cat "$RUNTIME_DIR/bun.version") at $BUN_BIN" >&2
      fi
    }

    # Resolves omp on the target user's full login PATH (not one hardcoded
    # location, per addendum §8: "using ... that user's full effective
    # login PATH"). Found -> leave it alone, return its directory. Absent
    # -> install the bundled binary to ~/.local/bin (postinst only) and
    # return that directory.
    resolve_or_install_omp() {
      local found_path found_dir
      found_path="$(run_as_target 'command -v omp' 2>/dev/null || true)"
      if [ -n "$found_path" ]; then
        found_dir="$(dirname "$found_path")"
        echo "omp-web: found existing omp at $found_path (preserved, not overwritten)" >&2
        echo "$found_dir"
        return 0
      fi
      local omp_bin="$TARGET_HOME/.local/bin/omp"
      install -D -m 0755 -o "$TARGET_USER" -g "$TARGET_USER" \
        "$RUNTIME_DIR/omp" "$omp_bin"
      echo "omp-web: installed bundled omp $(cat "$RUNTIME_DIR/omp.version") at $omp_bin" >&2
      echo "$TARGET_HOME/.local/bin"
    }

    sync_app() {
      local was_active=0
      if run_as_target 'systemctl --user is-active --quiet omp-web.service' 2>/dev/null; then
        was_active=1
        run_as_target 'systemctl --user stop omp-web.service'
      fi

      mkdir -p "$DEST"
      chown "$TARGET_USER:$TARGET_USER" "$TARGET_HOME/omp" "$DEST"
      # tar -cf - | tar -xf -: adds/overwrites every file from the new
      # release, never deletes a file the release doesn't ship (unlike
      # `rsync --delete`) — Design decision 5.
      tar -cf - -C "$OMP_WEB_SRC" . \
        | runuser -l "$TARGET_USER" -c "tar -xf - -C '$DEST'"

      if [ "$was_active" = 1 ]; then
        run_as_target 'systemctl --user daemon-reload && systemctl --user restart omp-web.service'
      fi
    }

    write_fresh_unit() {
      local omp_dir="$1"
      mkdir -p "$TARGET_HOME/.config/systemd/user"
      # Same-directory mktemp + mv (atomic rename): a kill mid-write
      # leaves only a stray temp file, never a truncated omp-web.service —
      # so a marker-absent resume never mistakes a corrupt partial unit
      # for "already written".
      local tmp_unit
      tmp_unit="$(mktemp "$TARGET_HOME/.config/systemd/user/.omp-web.service.XXXXXX")"
      sed \
        -e "s|__HOME__|$TARGET_HOME|g" \
        -e "s|^Environment=PATH=.*|Environment=PATH=$TARGET_HOME/.bun/bin:$omp_dir:/usr/local/bin:/usr/bin:/bin|" \
        "$SYSTEMD_SEED" > "$tmp_unit"
      chmod 0644 "$tmp_unit"
      mv "$tmp_unit" "$UNIT_PATH"
      chown "$TARGET_USER:$TARGET_USER" "$UNIT_PATH"
    }

    # Existing unit: NEVER rewritten. If its PATH= line covers neither the
    # bun dir nor the resolved omp dir, create/refresh the drop-in — the
    # only mechanism allowed to fix PATH on an already-deployed host
    # (Design decision 11 / addendum §8).
    ensure_unit_path_covers_omp() {
      local omp_dir="$1"
      local bun_dir="$TARGET_HOME/.bun/bin"
      local unit_path_line
      unit_path_line="$(grep -m1 '^Environment=PATH=' "$UNIT_PATH" 2>/dev/null || true)"
      if printf '%s' "$unit_path_line" | grep -qF "$bun_dir" \
        && { printf '%s' "$unit_path_line" | grep -qF "$omp_dir" \
             || printf '%s' "$unit_path_line" | grep -qF "$TARGET_HOME/.local/bin"; }; then
        return 0
      fi

      local desired
      desired="Environment=PATH=$bun_dir:$omp_dir:/usr/local/bin:/usr/bin:/bin"
      mkdir -p "$DROPIN_DIR"
      local wanted
      wanted="$(printf '[Service]\n%s\n' "$desired")"
      local existing=""
      [ -f "$DROPIN" ] && existing="$(cat "$DROPIN")"
      if [ "$existing" != "$wanted" ]; then
        printf '%s' "$wanted" > "$DROPIN"
        chown -R "$TARGET_USER:$TARGET_USER" "$DROPIN_DIR"
        echo "omp-web: wrote $DROPIN (existing unit's PATH did not cover $omp_dir)" >&2
        run_as_target 'systemctl --user daemon-reload'
        if run_as_target 'systemctl --user is-active --quiet omp-web.service' 2>/dev/null; then
          run_as_target 'systemctl --user restart omp-web.service'
        fi
      fi
    }

    seed_env_file() {
      local env_dir="$TARGET_HOME/omp/ops/env"
      mkdir -p "$env_dir"
      chown -R "$TARGET_USER:$TARGET_USER" "$TARGET_HOME/omp"
      local env_file="$env_dir/5010.env"
      if [ ! -f "$env_file" ]; then
        local host_ip
        host_ip="$(run_as_target "hostname -I | awk '{print \$1}'")"
        local password
        password="$(python3 "$DEST/tools/xor-secrets.py" get \
          --cipher "$SECRETS_DIR/secrets.env.xorb64" \
          --key "$SECRETS_DIR/xor.key" \
          --var OMP_WEB_PASSWORD)"
        # Same-directory mktemp + mv: a kill mid-write leaves only a stray
        # temp file, never a truncated 5010.env — a marker-absent resume
        # never mistakes a half-written env file for "already seeded".
        local tmp_env
        tmp_env="$(mktemp "$env_dir/.5010.env.XXXXXX")"
        {
          echo "OMP_WEB_HOSTNAME=$host_ip"
          echo "OMP_WEB_USERNAME=omp"
          echo "OMP_WEB_PASSWORD=$password"
          echo "OMP_WEB_TERMINALS=1"
        } > "$tmp_env"
        chmod 0600 "$tmp_env"
        mv "$tmp_env" "$env_file"
        chown "$TARGET_USER:$TARGET_USER" "$env_file"
        echo "omp-web: wrote $env_file (OMP_WEB_HOSTNAME=$host_ip)" >&2
      fi
    }

    seed_agent_dir() {
      local agent_dir="$TARGET_HOME/.omp/agent"
      mkdir -p "$agent_dir"
      chown -R "$TARGET_USER:$TARGET_USER" "$TARGET_HOME/.omp"

      local env_target="$agent_dir/.env"
      [ -f "$env_target" ] || : > "$env_target"
      chmod 0600 "$env_target"
      python3 "$DEST/tools/xor-secrets.py" merge \
        --cipher "$SECRETS_DIR/secrets.env.xorb64" \
        --key "$SECRETS_DIR/xor.key" \
        --target "$env_target" \
        --skip-var OMP_WEB_PASSWORD
      chown "$TARGET_USER:$TARGET_USER" "$env_target"

      [ -f "$agent_dir/models.yml" ] \
        || install -m 0644 -o "$TARGET_USER" -g "$TARGET_USER" \
             "$CONFIG_DIR/models.yml.default" "$agent_dir/models.yml"
      [ -f "$agent_dir/config.yml" ] \
        || install -m 0644 -o "$TARGET_USER" -g "$TARGET_USER" \
             "$CONFIG_DIR/config.yml.default" "$agent_dir/config.yml"
    }

    write_marker() {
      mkdir -p "$MARKER_DIR"
      chown "$TARGET_USER:$TARGET_USER" "$MARKER_DIR"
      local tmp
      tmp="$(mktemp "$MARKER_DIR/.install.complete.XXXXXX")"
      date -u +%FT%TZ > "$tmp"
      mv "$tmp" "$MARKER"
      chown "$TARGET_USER:$TARGET_USER" "$MARKER"
    }

    if [ ! -f "$MARKER" ]; then
      echo "omp-web: no completion marker at $MARKER — running fresh-install-or-resume (every step below is idempotent)" >&2
      sync_bun
      OMP_DIR="$(resolve_or_install_omp)"
      sync_app
      if [ -f "$UNIT_PATH" ]; then
        # Interrupted a previous run after the unit was written but before
        # the marker: never overwrite it, same as a normal upgrade would.
        ensure_unit_path_covers_omp "$OMP_DIR"
      else
        write_fresh_unit "$OMP_DIR"
      fi
      seed_env_file
      seed_agent_dir
      run_as_target 'systemctl --user daemon-reload && systemctl --user enable --now omp-web.service'
      write_marker
    else
      echo "omp-web: completion marker present — upgrade path (unit/env/agent dir untouched)" >&2
      sync_bun
      OMP_DIR="$(resolve_or_install_omp)"
      sync_app
      ensure_unit_path_covers_omp "$OMP_DIR"
    fi

    sleep 1
    if run_as_target 'systemctl --user is-active --quiet omp-web.service'; then
      echo "omp-web: omp-web.service is active for $TARGET_USER (port 5010)" >&2
    else
      echo "omp-web: omp-web.service is not active; check:" >&2
      echo "  runuser -l $TARGET_USER -c 'systemctl --user status omp-web.service --no-pager'" >&2
    fi
    ;;
esac

exit 0
```

- [ ] **Step 2: Syntax-check**

```bash
bash -n debian/postinst && echo POSTINST_SYNTAX_OK
chmod 0755 debian/postinst
```

Expected: `POSTINST_SYNTAX_OK`.

- [ ] **Step 3: Run the fixture harness — still expect `prerm`/`postrm` failures, everything else passes**

```bash
./tests/run-postinst-fixture-tests.sh
```

Expected: every `ok -` line through Test 6 (PATH drop-in), then a failure on Test 7 referencing
`debian/prerm: No such file or directory` — Task 9 makes that pass.

- [ ] **Step 4: Commit**

```bash
git add debian/postinst
git commit -m "feat: add debian/postinst with marker-driven fresh-install-or-resume and omp PATH handling (refs #25)"
```

---

## Task 9: `debian/prerm` and `debian/postrm`

**Files:**
- Create: `debian/prerm`
- Create: `debian/postrm`

- [ ] **Step 1: Write `debian/prerm`**

```bash
#!/bin/bash
# debian/prerm — omp-web
# Stops the user service on `apt remove` (not on upgrade — postinst's
# sync_app already stops/restarts as needed there) so no orphaned process
# keeps running against files this package is about to delete.
set -e

ROOT_PREFIX="${OMP_WEB_TEST_ROOT:-}"

find_running_user() {
  if [ -n "${OMP_WEB_TARGET_USER:-}" ]; then
    echo "$OMP_WEB_TARGET_USER"
    return 0
  fi
  for home in "${ROOT_PREFIX}"/home/*; do
    [ -f "$home/.config/systemd/user/omp-web.service" ] || continue
    basename "$home"
    return 0
  done
  return 1
}

case "$1" in
  remove)
    TARGET_USER="$(find_running_user)" || exit 0
    runuser -l "$TARGET_USER" -c 'systemctl --user stop omp-web.service' 2>/dev/null || true
    ;;
  upgrade|deconfigure|failed-upgrade)
    :
    ;;
esac

exit 0
```

- [ ] **Step 2: Write `debian/postrm`**

```bash
#!/bin/bash
# debian/postrm — omp-web
# Only ever touches /opt/omp-web (this package's own tree). Never removes
# anything under a user's $HOME: ~/omp/ompweb (synced app copy),
# ~/.config/systemd/user/omp-web.service{,.d/}, ~/omp/ops/env/5010.env, or
# ~/.omp/agent/{.env,config.yml,models.yml,sessions,...} — those are the
# user's live data and configuration, not package-owned files, and survive
# both `apt remove` and `apt purge`. An operator who wants those gone runs
# `rm -rf ~/omp/ompweb ~/.config/systemd/user/omp-web.service*` explicitly.
set -e

ROOT_PREFIX="${OMP_WEB_TEST_ROOT:-}"

case "$1" in
  purge)
    rm -rf "${ROOT_PREFIX}/opt/omp-web"
    ;;
  remove|upgrade|failed-upgrade|abort-install|abort-upgrade|disappear)
    :
    ;;
esac

exit 0
```

- [ ] **Step 3: Syntax-check both**

```bash
bash -n debian/prerm && bash -n debian/postrm && echo MAINTSCRIPTS_SYNTAX_OK
chmod 0755 debian/prerm debian/postrm
```

Expected: `MAINTSCRIPTS_SYNTAX_OK`.

- [ ] **Step 4: Run the full fixture harness — every test now passes**

```bash
./tests/run-postinst-fixture-tests.sh
```

Expected: every line begins `ok -`, ending with `ALL FIXTURE TESTS PASSED`, exit code `0`.

- [ ] **Step 5: Commit**

```bash
git add debian/prerm debian/postrm
git commit -m "feat: add debian/prerm and postrm, both home-directory-safe (refs #25)"
```

---

## Task 10: `debian/rules`

**Files:**
- Create: `debian/rules`

- [ ] **Step 1: Write the file**

```makefile
#!/usr/bin/make -f
export BUN := $(HOME)/.bun/bin/bun
export OMP := $(HOME)/.local/bin/omp

%:
	dh $@

override_dh_auto_build:
	$(BUN) install --frozen-lockfile
	PATH=$(HOME)/.bun/bin:$$PATH $(BUN) run build
	$(BUN) install --frozen-lockfile --production

override_dh_auto_install:
	mkdir -p debian/omp-web/opt/omp-web/current
	rsync -a \
		--exclude='.git' \
		--exclude='.worktrees' \
		--exclude='docs' \
		--exclude='.gh-issue' \
		--exclude='debian' \
		--exclude='debian_dist' \
		--exclude='release/seeds' \
		--exclude='tests' \
		./ debian/omp-web/opt/omp-web/current/

	mkdir -p debian/omp-web/opt/omp-web/runtime
	install -m 0755 $(BUN) debian/omp-web/opt/omp-web/runtime/bun
	install -m 0755 $(OMP) debian/omp-web/opt/omp-web/runtime/omp
	$(BUN) --version > debian/omp-web/opt/omp-web/runtime/bun.version
	$(OMP) --version | sed 's#.*/##' > debian/omp-web/opt/omp-web/runtime/omp.version

	mkdir -p debian/omp-web/opt/omp-web/config
	install -m 0644 release/seeds/models.yml debian/omp-web/opt/omp-web/config/models.yml.default
	install -m 0644 release/seeds/config.yml debian/omp-web/opt/omp-web/config/config.yml.default

	mkdir -p debian/omp-web/opt/omp-web/secrets
	install -m 0644 release/seeds/omp-web-secrets.env.xorb64 debian/omp-web/opt/omp-web/secrets/secrets.env.xorb64
	install -m 0644 release/seeds/omp-web-xor.key debian/omp-web/opt/omp-web/secrets/xor.key

	mkdir -p debian/omp-web/opt/omp-web/systemd
	install -m 0644 release/systemd/omp-web.service debian/omp-web/opt/omp-web/systemd/omp-web.service

override_dh_auto_test:
	true

override_dh_auto_clean:
	rm -rf .next

override_dh_strip:
	true

override_dh_shlibdeps:
	true

override_dh_dwz:
	true
```

> `debian/rules` targets **must** be tab-indented, not space-indented (`make` requirement). Copy this
> block with a tool that preserves literal tabs, or re-indent with `sed -i 's/^    /\t/' debian/rules`
> after pasting.

- [ ] **Step 2: Make it executable and syntax-sanity-check it**

```bash
chmod +x debian/rules
make -n -f debian/rules override_dh_auto_install >/dev/null && echo MAKE_SYNTAX_OK
```

Expected: `MAKE_SYNTAX_OK`.

> This target requires `release/seeds/{models,config}.yml` (Task 5's output) and
> `release/seeds/omp-web-{secrets.env.xorb64,xor.key}` (Task 11's `seal`, run against the assembled
> secrets bundle in Task 18) to already exist — `build-deb.sh` (Task 11) runs those steps before
> invoking `dpkg-buildpackage`. Running `dpkg-buildpackage` directly before that will fail at
> `install: cannot stat 'release/seeds/models.yml'` — expected, verified in Task 13.

- [ ] **Step 3: Commit**

```bash
git add debian/rules
git commit -m "feat: add debian/rules assembling /opt/omp-web from the built tree (refs #25)"
```

---

## Task 11: `release/seeds/assemble-secrets.sh` and `build-deb.sh`

`release/seeds/assemble-secrets.sh` is new in this revision: it merges today's owner-only local file
(`XAI_API_KEY`, `OMP_WEB_PASSWORD`) with the five provider keys that are already live, in plaintext, on
an existing fleet host's `~/.omp/agent/.env` — producing the full seven-key bundle
`tools/xor-secrets.py seal` needs — **without ever printing a value** and **without overwriting**
whatever the owner-resolved file already has for a given key.

**Files:**
- Create: `release/seeds/assemble-secrets.sh`
- Create: `build-deb.sh`

- [ ] **Step 1: Write `release/seeds/assemble-secrets.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
# Assembles the full 7-key packaged-secrets plaintext bundle from two
# sources, without ever printing a value:
#   1. The owner-only local file (today: XAI_API_KEY, OMP_WEB_PASSWORD) —
#      values here always win and are never overwritten.
#   2. The five provider keys already live, in plaintext, in an existing
#      fleet host's ~/.omp/agent/.env (DEEPSEEK_API_KEY, AGENT_PLAN_API_KEY,
#      VOLCENGINE_PLAN_API_KEY, BAILIAN_CLI_API_KEY, ZHIPU_API_KEY) — only
#      keys ABSENT from the owner file are pulled in.
OWNER_FILE="${1:?usage: assemble-secrets.sh OWNER_FILE OUT_FILE [FLEET_HOST]}"
OUT_FILE="${2:?usage: assemble-secrets.sh OWNER_FILE OUT_FILE [FLEET_HOST]}"
FLEET_HOST="${3:-joysort@172.30.3.24}"
FLEET_KEYS='^(DEEPSEEK|AGENT_PLAN|VOLCENGINE_PLAN|BAILIAN_CLI|ZHIPU)_API_KEY='

[ -f "$OWNER_FILE" ] || { echo "assemble-secrets.sh: $OWNER_FILE not found" >&2; exit 1; }

TMP_OUT="$(mktemp "$(dirname "$OUT_FILE")/.$(basename "$OUT_FILE").XXXXXX")"
cp "$OWNER_FILE" "$TMP_OUT"

EXISTING_KEYS="$(cut -d= -f1 "$TMP_OUT")"
FLEET_LINES="$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$FLEET_HOST" \
  "grep -E '$FLEET_KEYS' ~/.omp/agent/.env")"

ADDED_COUNT=0
while IFS= read -r line; do
  key="${line%%=*}"
  if ! printf '%s\n' "$EXISTING_KEYS" | grep -qx "$key"; then
    printf '%s\n' "$line" >> "$TMP_OUT"
    ADDED_COUNT=$((ADDED_COUNT + 1))
  fi
done <<< "$FLEET_LINES"

chmod 0600 "$TMP_OUT"
mv "$TMP_OUT" "$OUT_FILE"
echo "assemble-secrets.sh: wrote $OUT_FILE — $(cut -d= -f1 "$OUT_FILE" | wc -l) total key(s), $ADDED_COUNT pulled from $FLEET_HOST, $(cut -d= -f1 "$OWNER_FILE" | wc -l) from $OWNER_FILE (never overwritten)"
cut -d= -f1 "$OUT_FILE" | sort
```

Every place a value could leak — `cp`, `grep` over SSH, the `while read` loop — writes straight into
`$TMP_OUT` and is never echoed; the only stdout is the final key-name list (`cut -d= -f1`), matching
Security notes' "no secret value is ever printed" rule.

- [ ] **Step 2: Syntax-check and make executable**

```bash
bash -n release/seeds/assemble-secrets.sh && echo ASSEMBLE_SYNTAX_OK
chmod +x release/seeds/assemble-secrets.sh
```

Expected: `ASSEMBLE_SYNTAX_OK`.

- [ ] **Step 3: Write `build-deb.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SEED_HOST="${OMP_WEB_SEED_HOST:-joysort@172.30.3.24}"
OWNER_SECRETS="${OMP_WEB_OWNER_SECRETS:-$HOME/joysort-release-credential/omp-web-secrets.env.plain}"
ASSEMBLED_SECRETS="${OMP_WEB_ASSEMBLED_SECRETS:-$HOME/joysort-release-credential/omp-web-secrets.assembled.env.plain}"

if [ ! -f "$OWNER_SECRETS" ]; then
  echo "error: $OWNER_SECRETS not found." >&2
  echo "Create it first — see docs/plans/2026-08-20-omp-web-release-pipeline.md, Task 18." >&2
  exit 1
fi

echo "==> Assembling the full provider-secrets bundle (owner file + fleet-sourced keys)"
./release/seeds/assemble-secrets.sh "$OWNER_SECRETS" "$ASSEMBLED_SECRETS" "$SEED_HOST"

echo "==> Fetching seed models.yml/config.yml from $SEED_HOST"
mkdir -p release/seeds
./release/seeds/fetch-seeds.sh "$SEED_HOST"

echo "==> Sealing the assembled provider secrets"
python3 tools/xor-secrets.py seal \
  --plain "$ASSEMBLED_SECRETS" \
  --out-cipher release/seeds/omp-web-secrets.env.xorb64 \
  --out-key release/seeds/omp-web-xor.key

echo "==> Running dpkg-buildpackage"
dpkg-buildpackage -us -uc -b

VERSION="$(dpkg-parsechangelog -S Version)"
mkdir -p debian_dist
mv "../omp-web_${VERSION}_amd64.deb" "debian_dist/omp-web_${VERSION}_amd64.deb"
rm -f "../omp-web_${VERSION}_amd64.buildinfo" "../omp-web_${VERSION}_amd64.changes"

echo "==> Built debian_dist/omp-web_${VERSION}_amd64.deb"
```

- [ ] **Step 4: Syntax-check and make executable**

```bash
bash -n build-deb.sh && echo BUILD_DEB_SYNTAX_OK
chmod +x build-deb.sh
```

Expected: `BUILD_DEB_SYNTAX_OK`.

- [ ] **Step 5: Commit**

```bash
git add release/seeds/assemble-secrets.sh build-deb.sh
git commit -m "feat: add assemble-secrets.sh and build-deb.sh orchestrating the full release build (refs #25)"
```

---

## Task 12: `.gitignore` additions

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Append the Debian-packaging block**

```
# Debian packaging build artifacts (see docs/plans/2026-08-20-omp-web-release-pipeline.md)
/debian_dist/
/debian/omp-web/
/debian/.debhelper/
/debian/debhelper-build-stamp
/debian/files
/debian/*.substvars
/debian/*.debhelper.log

# release/seeds outputs are generated at build time by release/seeds/fetch-seeds.sh
# and tools/xor-secrets.py seal — never commit fetched config or sealed secrets
release/seeds/config.yml
release/seeds/models.yml
release/seeds/omp-web-secrets.env.xorb64
release/seeds/omp-web-xor.key
```

- [ ] **Step 2: Verify it actually ignores the generated files**

```bash
git status --porcelain release/seeds/ debian/
```

Expected: empty (all generated artifacts from Tasks 5–11's dry runs are now ignored).

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore debian build output and generated release seeds (refs #25)"
```

---

## Task 13: Local end-to-end build dry run

**Files:** none — exercises Tasks 2–12 together before wiring CI.

- [ ] **Step 1: Create a throwaway local owner-secrets file** (real values live only at
  `~/joysort-release-credential/omp-web-secrets.env.plain`, Task 18; for this dry run, use
  deterministic sample values so the package builds without touching real credentials)

```bash
mkdir -p /tmp/omp-web-dryrun
cat > /tmp/omp-web-dryrun/owner-secrets.env.plain <<'EOF'
XAI_API_KEY=dryrun-demo-xai
OMP_WEB_PASSWORD=dryrun-demo-password
EOF
```

- [ ] **Step 2: Run the build**

```bash
OMP_WEB_OWNER_SECRETS=/tmp/omp-web-dryrun/owner-secrets.env.plain \
  OMP_WEB_ASSEMBLED_SECRETS=/tmp/omp-web-dryrun/assembled-secrets.env.plain \
  ./build-deb.sh
```

Expected: `==> Assembling the full provider-secrets bundle ...` followed by a 7-line key-name list
(`AGENT_PLAN_API_KEY BAILIAN_CLI_API_KEY DEEPSEEK_API_KEY OMP_WEB_PASSWORD VOLCENGINE_PLAN_API_KEY
XAI_API_KEY ZHIPU_API_KEY`, no values), `==> Fetching seed models.yml/config.yml ...`, `==> Sealing the
assembled provider secrets`, a multi-minute `dpkg-buildpackage` run (the payload includes
`node_modules` and `.next` — this is the slow step), ending with `==> Built
debian_dist/omp-web_0.3.0_amd64.deb`.

- [ ] **Step 3: Inspect the package**

```bash
dpkg-deb -I debian_dist/omp-web_0.3.0_amd64.deb
dpkg-deb -c debian_dist/omp-web_0.3.0_amd64.deb | grep -E '/opt/omp-web/(runtime|config|secrets|systemd)/'
```

Expected: control metadata showing `Package: omp-web`, `Version: 0.3.0`, `Architecture: amd64`, plus a
file listing that includes `./opt/omp-web/runtime/bun`, `./opt/omp-web/runtime/omp`,
`./opt/omp-web/config/models.yml.default`, `./opt/omp-web/config/config.yml.default`,
`./opt/omp-web/secrets/secrets.env.xorb64`, `./opt/omp-web/secrets/xor.key`,
`./opt/omp-web/systemd/omp-web.service`.

- [ ] **Step 4: Confirm the secrets are actually obfuscated in the built package** (a smoke test of
  the Security notes claim, not a security boundary)

```bash
dpkg-deb --fsys-tarfile debian_dist/omp-web_0.3.0_amd64.deb \
  | tar -xO ./opt/omp-web/secrets/secrets.env.xorb64 \
  | grep -c dryrun-demo-password || echo "NOT_FOUND_IN_CIPHERTEXT (expected)"
```

Expected: `NOT_FOUND_IN_CIPHERTEXT (expected)` — the literal sample value does not appear in the
ciphertext.

- [ ] **Step 5: Confirm no dry-run secret value leaked into shell history or this session's output**

```bash
grep -rn 'dryrun-demo' /tmp/omp-web-dryrun/*.log 2>/dev/null; echo "checked (no log files expected)"
```

Expected: `checked (no log files expected)` — `build-deb.sh` and `assemble-secrets.sh` never write a
log file containing a value; the only artifacts under `/tmp/omp-web-dryrun/` are the two plaintext
input/intermediate files, which is expected for a throwaway local dry run.

- [ ] **Step 6: Clean up the dry-run artifacts** (do not commit `debian_dist/` — gitignored)

```bash
rm -rf /tmp/omp-web-dryrun release/seeds/*.yml release/seeds/omp-web-secrets.env.xorb64 release/seeds/omp-web-xor.key
```

No commit for this task — it is a verification-only checkpoint.

---

## Task 14: `.github/workflows/release.yml`

Splits into a `build` job (always runs, on both a tag push and `workflow_dispatch`, produces and
uploads a `.deb` artifact) and a `publish` job (runs **only** on a tag push, never on
`workflow_dispatch` — Design decision 3) that references the canonical `update-apt-repo` action
directly, with **no `GH_PAT` anywhere** (Design decisions 6–8).

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Write the file**

```yaml
name: Release Debian package

on:
  push:
    tags:
      - "omp-web-v*"
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: release-deb-${{ github.ref }}
  cancel-in-progress: false

jobs:
  build:
    name: Build omp-web .deb
    runs-on: [self-hosted, Linux, X64, omp-web]
    outputs:
      version: ${{ steps.version.outputs.version }}
    steps:
      - name: Check out
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Resolve release version
        id: version
        shell: bash
        run: |
          changelog_version="$(dpkg-parsechangelog -S Version)"
          if [[ "${{ github.ref_type }}" == "tag" ]]; then
            tag_version="${GITHUB_REF_NAME#omp-web-v}"
            if [[ "$tag_version" != "$changelog_version" ]]; then
              echo "Tag ${GITHUB_REF_NAME} does not match debian/changelog version ${changelog_version}" >&2
              exit 1
            fi
            echo "version=$changelog_version" >> "$GITHUB_OUTPUT"
          else
            # workflow_dispatch: a distinct, non-colliding test version per
            # docs/workspace/joysort2026 release-hardening-rules.md ("Do not
            # use ~ for test builds"; apt sorts a bare +suffix higher, never
            # replacing a formal tagged version in the repo). This build job
            # produces an artifact only — the publish job below never runs
            # for workflow_dispatch, so this version never reaches the apt
            # repo (Design decision 3).
            echo "version=${changelog_version}+github.action.${GITHUB_RUN_NUMBER}" >> "$GITHUB_OUTPUT"
          fi
          echo "Resolved build version: $(cat "$GITHUB_OUTPUT" | tail -1)"

      - name: Apply resolved version to debian/changelog
        run: |
          VERSION="${{ steps.version.outputs.version }}"
          sed -i "1s/(${CHANGELOG_VER:-$(dpkg-parsechangelog -S Version)})/($VERSION)/" debian/changelog
          head -3 debian/changelog

      - name: Build .deb
        env:
          OMP_WEB_OWNER_SECRETS: /home/joysort/joysort-release-credential/omp-web-secrets.env.plain
          OMP_WEB_ASSEMBLED_SECRETS: /home/joysort/joysort-release-credential/omp-web-secrets.assembled.env.plain
        run: ./build-deb.sh

      - name: Upload .deb artifact
        uses: actions/upload-artifact@v4
        with:
          name: omp-web-deb-${{ steps.version.outputs.version }}
          path: debian_dist/*.deb
          retention-days: 30

  publish:
    name: Publish to the R2 apt repository
    needs: build
    if: github.ref_type == 'tag'
    runs-on: [self-hosted, Linux, X64, omp-web]
    steps:
      - name: Check out
        uses: actions/checkout@v4

      - name: Download .deb artifact
        uses: actions/download-artifact@v4
        with:
          name: omp-web-deb-${{ needs.build.outputs.version }}
          path: .

      # Prerequisite: see docs/plans/2026-08-20-omp-web-release-pipeline.md,
      # Design decision 8 / Task 15. This step references the canonical
      # action verbatim, with no PAT of any kind declared in this workflow.
      - name: Update APT repository metadata
        uses: JoySort/joysort-release-tools/.github/actions/update-apt-repo@main
        with:
          r2-account-id: ${{ vars.R2_ACCOUNT_ID }}
          r2-access-key-id: ${{ secrets.R2_ACCESS_KEY_ID }}
          r2-secret-access-key: ${{ secrets.R2_SECRET_ACCESS_KEY }}
          r2-bucket: ${{ vars.R2_BUCKET }}
          gpg-private-key: ${{ secrets.REPO_GPG_PRIVATE_KEY }}
          gpg-passphrase: ${{ secrets.REPO_GPG_PASSPHRASE }}
          codename: jammy

      - name: Verify the package landed in the apt repo
        shell: bash
        run: |
          curl -fsS "https://repo.joysort.cc/apt/dists/jammy/main/binary-amd64/Packages" \
            | grep -A2 "^Package: omp-web$"
          curl -fsS "https://repo.joysort.cc/apt/dists/jammy/main/binary-amd64/Packages" \
            | grep -A2 "^Package: omp-web$" | grep -q "Version: ${{ needs.build.outputs.version }}"
```

- [ ] **Step 2: Validate YAML syntax**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))" && echo YAML_OK
```

Expected: `YAML_OK`.

- [ ] **Step 3: Confirm no `GH_PAT`/`JOYSORT_PAT` appears anywhere in the workflow**

```bash
grep -c -iE 'GH_PAT|JOYSORT_PAT' .github/workflows/release.yml || echo 0
```

Expected: `0`.

- [ ] **Step 4: Confirm `workflow_dispatch` never reaches the publish job**

```bash
grep -A2 '^  publish:' .github/workflows/release.yml
```

Expected: shows `if: github.ref_type == 'tag'` directly under the `publish:` job — the only gate
standing between any run and a publish, so a `workflow_dispatch` run (`github.ref_type` is always
`branch` for a dispatch) never executes this job, satisfying "a manual `workflow_dispatch` build must
never be able to supersede or overwrite the apt repo's currently-published tagged production package"
(addendum §1).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "feat: add release.yml — build always, publish only on omp-web-v* tags, no GH_PAT (refs #25)"
```

---

## Task 15: Resolve the cross-repo action-access prerequisite (Design decision 8)

This task is infrastructure configuration on **`JoySort/joysort-release-tools`** and (if needed)
`n0rthwood/omp-web`'s own repository visibility — not something this plan's author can execute (out of
scope: "do not touch GitHub"). It is stated here as the single, concrete, zero-new-credential
prerequisite the `publish` job (Task 14) needs, keeping the exact canonical action reference from
Design decision 7 (`JoySort/joysort-release-tools/.github/actions/update-apt-repo`) unchanged — no
fork, no copy, no new repository, no reimplementation. Until it is done, `publish` fails at "Unable to
resolve action ... not found"; that failure is the correct, honest signal this step is still
outstanding, not a bug in the workflow.

**Files:** none (GitHub repository configuration).

- [ ] **Step 1: Confirm the blocking condition still holds**

```bash
gh api repos/n0rthwood/omp-web --jq .private
gh api repos/JoySort/joysort-release-tools --jq .private
```

If the first prints `false` and the second prints `true`, the prerequisite below is still required.

- [ ] **Step 2: Make `n0rthwood/omp-web` private, then grant it access to
  `JoySort/joysort-release-tools`'s private actions** — GitHub's built-in private-action sharing
  (https://docs.github.com/en/actions/how-tos/reuse-automations/share-across-private-repositories)
  is the only mechanism that lets a consuming workflow resolve
  `uses: JoySort/joysort-release-tools/.github/actions/update-apt-repo@main` with **zero token of any
  kind** — no PAT, no App, no ambient credential — but it is restricted to private consuming
  repositories (verified against GitHub's own docs: "Access is allowed only from private
  repositories"). This is an owner-level decision (repo visibility change has consequences beyond this
  pipeline — issue tracker, npm publish workflow, existing stars/forks — the owner should confirm it
  explicitly, exactly like the R2/GPG secrets and runner registration in Tasks 16–17 also require
  action outside this plan's authority):

  ```bash
  # 1. Repo owner (n0rthwood), one time:
  gh repo edit n0rthwood/omp-web --visibility private --accept-visibility-change-consequences

  # 2. JoySort org admin, one time, via the GitHub UI (no API for this specific
  #    setting): open JoySort/joysort-release-tools -> Settings -> Actions ->
  #    General -> "Access" section -> select "Accessible from repositories
  #    owned by 'n0rthwood' user" -> Save.
  ```

- [ ] **Step 3: Verify resolution**

```bash
gh api repos/n0rthwood/omp-web --jq .private
gh workflow run release.yml --repo n0rthwood/omp-web
gh run watch --repo n0rthwood/omp-web --exit-status \
  $(gh run list --repo n0rthwood/omp-web --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
```

Expected: `true` for the visibility check; the `build` job succeeds (it never depended on this
prerequisite); the `publish` job is **skipped** (`workflow_dispatch` never satisfies
`github.ref_type == 'tag'` — Design decision 3), so this step alone cannot fully prove the action
resolves. Full proof happens at the first real tag push (Task 21), where `publish` actually runs; if it
still fails with "Unable to resolve action", re-check Step 2's two sub-steps were both completed on the
correct repositories.

---

## Task 16: Register the self-hosted Actions runner for `n0rthwood/omp-web`

`n0rthwood/omp-web` has no repository-level self-hosted runner yet (JoySort's org-level runners are
scoped to JoySort-org repos only, by GitHub design — they cannot serve a different owner's repo).

**Files:** none (infrastructure setup on `172.30.3.123`).

- [ ] **Step 1: Confirm no runner is registered yet**

```bash
gh api /repos/n0rthwood/omp-web/actions/runners --jq '{total_count, runners}'
```

Expected: `{"total_count":0,"runners":[]}`.

- [ ] **Step 2: Get a registration token**

```bash
REG_TOKEN="$(gh api -X POST /repos/n0rthwood/omp-web/actions/runners/registration-token --jq .token)"
echo "REG_TOKEN captured ($(echo -n "$REG_TOKEN" | wc -c) chars)"
```

Expected: a short-lived opaque token string, captured into `$REG_TOKEN` (never printed).

- [ ] **Step 3: Download and configure the runner**

```bash
RUNNER_VERSION="$(gh api repos/actions/runner/releases/latest --jq '.tag_name' | sed 's/^v//')"
sudo mkdir -p /opt/actions-runner/n0rthwood-ompweb
sudo chown joysort:joysort /opt/actions-runner/n0rthwood-ompweb
cd /opt/actions-runner/n0rthwood-ompweb
curl -o actions-runner-linux-x64.tar.gz -L \
  "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
tar xzf actions-runner-linux-x64.tar.gz

./config.sh \
  --url https://github.com/n0rthwood/omp-web \
  --token "$REG_TOKEN" \
  --name omp-web-builder-123 \
  --labels self-hosted,Linux,X64,omp-web \
  --work _work \
  --unattended
```

Expected: `√ Connected to GitHub` … `√ Runner successfully added` … `√ Runner connection is good`.

- [ ] **Step 4: Install as a persistent systemd service, running as `joysort`**

```bash
sudo ./svc.sh install joysort
sudo ./svc.sh start
sudo ./svc.sh status
```

Expected: `active (running)`.

- [ ] **Step 5: Confirm GitHub sees it with the right labels**

```bash
gh api /repos/n0rthwood/omp-web/actions/runners --jq '.runners[] | {name, status, labels: [.labels[].name]}'
```

Expected: one entry, `"status": "online"`, `"labels"` containing `self-hosted`, `Linux`, `X64`,
`omp-web`.

No commit — infrastructure state, not repo content.

---

## Task 17: Provision the R2/GPG GitHub Actions vars/secrets on `n0rthwood/omp-web`

Reads the runner's already-existing local credential files **once**, to seed real repo secrets — after
this, the workflow never touches those files again (Design decision 6).

**Files:** none (GitHub repo vars/secrets).

- [ ] **Step 1: Confirm the runner-local credential files this task reads from actually exist**

```bash
test -f ~/joysort-release-credential/joysort-gpg-private.asc && echo GPG_KEY_OK
test -f ~/joysort-release-credential/cloudflare.conf && echo CLOUDFLARE_CONF_OK
grep -oE '^[A-Z_]+=' ~/joysort-release-credential/cloudflare.conf
```

Expected: `GPG_KEY_OK`, `CLOUDFLARE_CONF_OK`, and a variable-name list including `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, and one of `CLOUDFLARE_ACCOUNT_ID`/`R2_ACCOUNT_ID`.

- [ ] **Step 2: Set the two repo vars**

```bash
source ~/joysort-release-credential/cloudflare.conf
gh variable set R2_ACCOUNT_ID --repo n0rthwood/omp-web --body "${R2_ACCOUNT_ID:-$CLOUDFLARE_ACCOUNT_ID}"
gh variable set R2_BUCKET --repo n0rthwood/omp-web --body "joysort-repo"
```

- [ ] **Step 3: Set the four repo secrets** (values never echoed to the transcript)

```bash
source ~/joysort-release-credential/cloudflare.conf
gh secret set R2_ACCESS_KEY_ID --repo n0rthwood/omp-web --body "$R2_ACCESS_KEY_ID"
gh secret set R2_SECRET_ACCESS_KEY --repo n0rthwood/omp-web --body "$R2_SECRET_ACCESS_KEY"
gh secret set REPO_GPG_PRIVATE_KEY --repo n0rthwood/omp-web < ~/joysort-release-credential/joysort-gpg-private.asc
read -rsp "GPG passphrase (from cloudflare.conf or the release owner): " GPG_PASS && echo
gh secret set REPO_GPG_PASSPHRASE --repo n0rthwood/omp-web --body "$GPG_PASS"
unset GPG_PASS
```

- [ ] **Step 4: Confirm they're set, and that no `GH_PAT`/`JOYSORT_PAT` was created alongside them**

```bash
gh secret list --repo n0rthwood/omp-web
gh variable list --repo n0rthwood/omp-web
```

Expected secrets: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `REPO_GPG_PRIVATE_KEY`,
`REPO_GPG_PASSPHRASE` — no `GH_PAT`, no `JOYSORT_PAT`. Expected vars: `R2_ACCOUNT_ID`, `R2_BUCKET`.

No commit — GitHub repo configuration, not repo content.

---

## Task 18: Assemble and verify the real full packaged-secrets bundle

Exercises `release/seeds/assemble-secrets.sh` (Task 11) against the **real** owner-resolved local file
and the **real** fleet host — not the Task 13 dry run — confirming the full 7-key bundle assembles
correctly without ever printing a value, before the first real build.

**Files:** none (runner-local files only; nothing here is committed to the repo — the owner file and
its assembled derivative both live at `~/joysort-release-credential/`, matching where
`cloudflare.conf`/the GPG key already live, and stay outside the repo tree entirely).

- [ ] **Step 1: Re-confirm today's owner file still has exactly the two owner-resolved keys**

```bash
cut -d= -f1 ~/joysort-release-credential/omp-web-secrets.env.plain | sort
```

Expected:
```
OMP_WEB_PASSWORD
XAI_API_KEY
```

- [ ] **Step 2: Run the assembly script for real**

```bash
./release/seeds/assemble-secrets.sh \
  ~/joysort-release-credential/omp-web-secrets.env.plain \
  ~/joysort-release-credential/omp-web-secrets.assembled.env.plain \
  joysort@172.30.3.24
```

Expected final line: a sorted 7-key list —
```
AGENT_PLAN_API_KEY
BAILIAN_CLI_API_KEY
DEEPSEEK_API_KEY
OMP_WEB_PASSWORD
VOLCENGINE_PLAN_API_KEY
XAI_API_KEY
ZHIPU_API_KEY
```
— and the summary line reports `2 from ~/joysort-release-credential/omp-web-secrets.env.plain (never
overwritten)` and `5 pulled from joysort@172.30.3.24`.

- [ ] **Step 3: Confirm the two owner-resolved values were preserved untouched** (compare only that
  the first two lines of the assembled file are byte-identical to the owner file's two lines — never
  print either value)

```bash
diff <(sort ~/joysort-release-credential/omp-web-secrets.env.plain) \
     <(grep -E '^(OMP_WEB_PASSWORD|XAI_API_KEY)=' ~/joysort-release-credential/omp-web-secrets.assembled.env.plain | sort)
```

Expected: no output (the owner's `XAI_API_KEY`/`OMP_WEB_PASSWORD` lines are present in the assembled
file exactly as the owner set them, not overwritten by anything fleet-sourced).

- [ ] **Step 4: Confirm file permissions on the assembled file**

```bash
stat -c '%a %U:%G' ~/joysort-release-credential/omp-web-secrets.assembled.env.plain
```

Expected: `600 joysort:joysort` (the `chmod 0600` in `assemble-secrets.sh` before the atomic `mv`).

No commit — runner-local file, never enters git.

---

## Task 19: LXC test container on `172.30.3.24` — fresh Ubuntu 22.04, no `joysort` user

Per addendum §4, this container must have **no** manual `useradd`, no `git clone`, no direct `dpkg -i`
of a manually copied `.deb`, and no ad hoc runtime download outside what `postinst` performs —
**only the JoySort apt source and signing key are pre-provisioned, nothing else**. All setup and
verification below therefore uses `lxc exec` (already available with zero pre-provisioning) rather
than SSH into the container, so no package (`openssh-server` or otherwise) needs installing before the
`apt install omp-web` step itself.

**Files:** none for this task (the LXC container is disposable infrastructure state, not repo content;
the port-forward unit used by Task 20's HTTP checks is created inline in Step 5 below and is
intentionally not committed — see that step).

- [ ] **Step 1: Install LXD and initialize it, checking for a subnet collision with the LAN**

```bash
ssh joysort@172.30.3.24 'sudo snap install lxd'
ssh joysort@172.30.3.24 'sudo lxd init --auto'
ssh joysort@172.30.3.24 'lxc network get lxdbr0 ipv4.address'
```

Expected: an address in a private range that is **not** `10.10.170.0/24` (this host's real LAN). If it
collides:

```bash
ssh joysort@172.30.3.24 'lxc network set lxdbr0 ipv4.address 10.61.77.1/24'
```

- [ ] **Step 2: Allow LXC container outbound internet access** (per
  `/opt/workspace/joysort2026/joysort-release-infra/docs/release-hardening-rules.md`, "LXC Internet
  Access")

```bash
ssh joysort@172.30.3.24 'sudo iptables -I FORWARD 1 -i lxdbr0 -j ACCEPT'
ssh joysort@172.30.3.24 'sudo iptables -I FORWARD 1 -o lxdbr0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT'
ssh joysort@172.30.3.24 'sudo iptables -t nat -A POSTROUTING -s 10.61.77.0/24 ! -d 10.61.77.0/24 -j MASQUERADE'
```

(Adjust the subnet to whatever `lxc network get lxdbr0 ipv4.address` reported in Step 1.)

- [ ] **Step 3: Launch the container**

```bash
ssh joysort@172.30.3.24 \
  'lxc launch ubuntu:22.04 ompweb-test -c limits.memory=4GiB -c limits.cpu=4 && lxc config device override ompweb-test root size=25GB'
ssh joysort@172.30.3.24 'lxc list ompweb-test --format csv -c 4'
```

Expected: an IPv4 address on the `lxdbr0` subnet.

- [ ] **Step 4: Confirm no `joysort` user exists in the fresh container** (addendum §4, mandatory
  assertion before install)

```bash
ssh joysort@172.30.3.24 "lxc exec ompweb-test -- id joysort" && echo "UNEXPECTED: joysort already exists" || echo "CONFIRMED_NO_JOYSORT_USER"
```

Expected: `CONFIRMED_NO_JOYSORT_USER` (the `id joysort` command fails inside the container, confirming
a genuinely bare host).

- [ ] **Step 5: Provision only the apt source and signing key — nothing else, entirely via `lxc exec`**

```bash
ssh joysort@172.30.3.24 "lxc exec ompweb-test -- mkdir -p /etc/apt/keyrings"
ssh joysort@172.30.3.24 "cat /etc/apt/keyrings/joysort-archive-keyring.gpg | lxc exec ompweb-test -- tee /etc/apt/keyrings/joysort-archive-keyring.gpg > /dev/null"
ssh joysort@172.30.3.24 "cat /etc/apt/sources.list.d/joysort.sources | lxc exec ompweb-test -- tee /etc/apt/sources.list.d/joysort.sources > /dev/null"
ssh joysort@172.30.3.24 "lxc exec ompweb-test -- apt-get update -qq"
```

Expected final command: `Reading package lists... Done` with no `NO_PUBKEY`/`404` errors — the base
Ubuntu 22.04 image's stock `apt`/`gpgv` (already present, not something this step installs) is
sufficient to verify the `Signed-By:` keyring, and the container can already see `repo.joysort.cc`'s
feed (empty of `omp-web` until Task 21 publishes).

- [ ] **Step 6: Set up host-side HTTP port forwarding for Task 22's verification** (HTTP only — the
  addendum's required checks are account/service/port/health/models/terminals/bun/omp/state-layout,
  none of which need a forwarded SSH port; `lxc exec` already gives full container access with zero
  pre-provisioning, so no `openssh-server` is installed in the container for this)

```bash
ssh joysort@172.30.3.24 'which socat >/dev/null || sudo apt-get install -y -qq socat'
CONTAINER_IP="$(ssh joysort@172.30.3.24 'lxc list ompweb-test --format csv -c 4')"
ssh joysort@172.30.3.24 "nohup socat TCP-LISTEN:5011,fork,reuseaddr TCP:${CONTAINER_IP}:5010 >/tmp/ompweb-forward.log 2>&1 &"
```

`socat` (the host, not the container — installing tooling on the pre-existing runner/test host is
unrelated to the addendum's "nothing else pre-provisioned" rule, which applies only to the fresh
container under test) is installed first, then the forward is launched against the container's actual
IP, captured once.

- [ ] **Step 7: Verify the forward works end-to-end**

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://172.30.3.24:5011/
```

Expected: connection refused or a non-200 status — omp-web isn't installed in the container yet;
that's Task 22.

---

## Task 20: Merge the feature branch to `main` — no pull request

Per standing project preference: "NEVER create a pull request unless the user explicitly asks for
one... merge it directly into main" (Design decision 20). Everything through Task 19 is committed on
`feature/omp25-debian-apt-release-pipeline`; the fixture-test suite (Task 9 Step 4) already proves the
packaging logic in isolation, so this merge happens before the real tag/LXC proof, matching how the
original plan's own Task 16 ordered "merge, then tag, then verify."

**Files:** none (git operations only).

- [ ] **Step 1: Confirm the branch is clean and the fixture suite still passes**

```bash
git status --porcelain
./tests/run-postinst-fixture-tests.sh
python3 -m unittest tools.test_xor_secrets -v
```

Expected: no uncommitted changes; `ALL FIXTURE TESTS PASSED`; all three `xor-secrets` unit tests `ok`.

- [ ] **Step 2: Merge directly into `main`**

```bash
cd /home/joysort/omp/ompweb
git checkout main
git pull
git merge --no-ff feature/omp25-debian-apt-release-pipeline \
  -m "Merge feature/omp25-debian-apt-release-pipeline: Debian/apt release pipeline (closes #25)"
git push origin main
```

Expected: fast-forward or a clean merge commit, then `main` pushed successfully — no PR opened at any
point in this task.

- [ ] **Step 3: Confirm the merge landed**

```bash
git log --oneline -1 main
gh api repos/n0rthwood/omp-web/commits/main --jq '.commit.message' | head -1
```

Expected: the merge commit message from Step 2.

---

## Task 21: First real tagged release

**Files:** none — exercises the full pipeline built in Tasks 2–17 together, from `main`.

- [ ] **Step 1: Tag the release from `main`**

```bash
cd /home/joysort/omp/ompweb
git checkout main && git pull
git tag omp-web-v0.3.0
git push origin omp-web-v0.3.0
```

- [ ] **Step 2: Watch the workflow**

```bash
gh run watch --repo n0rthwood/omp-web --exit-status \
  $(gh run list --repo n0rthwood/omp-web --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
```

Expected: `build` succeeds, `publish` runs (this time `github.ref_type == 'tag'` is true) and succeeds,
ending with the `Verify the package landed in the apt repo` step printing:
```
Package: omp-web
Version: 0.3.0
Architecture: amd64
```

If `publish` instead fails with "Unable to resolve action ... not found", Task 15 was not completed —
go back and finish it before retrying this tag.

- [ ] **Step 3: Confirm from outside CI too**

```bash
curl -fsS https://repo.joysort.cc/apt/dists/jammy/main/binary-amd64/Packages | grep -A5 '^Package: omp-web$'
```

Expected: the same `Package`/`Version`/`Architecture` block, plus a
`Filename: pool/main/o/omp-web/omp-web_0.3.0_amd64.deb` line.

- [ ] **Step 4: Sanity-check a `workflow_dispatch` run never republishes over the tagged version**

```bash
gh workflow run release.yml --repo n0rthwood/omp-web
gh run watch --repo n0rthwood/omp-web --exit-status \
  $(gh run list --repo n0rthwood/omp-web --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run view --repo n0rthwood/omp-web --json jobs \
  $(gh run list --repo n0rthwood/omp-web --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId') \
  --jq '.jobs[] | {name, conclusion}'
```

Expected: the `build` job's `conclusion` is `success`; the `publish` job does not appear as executed
(shows `skipped`) — confirming Design decision 3 holds in practice, not just on paper.

```bash
curl -fsS https://repo.joysort.cc/apt/dists/jammy/main/binary-amd64/Packages | grep -A2 '^Package: omp-web$'
```

Expected: still `Version: 0.3.0` — unchanged by the dispatch run.

No commit — this task publishes, it doesn't change repo content further.

---

## Task 22: Fresh install verification — full addendum §4 checklist, `omp` CLI, structural `.202` parity

**Files:** none — verification only, against the LXC container provisioned in Task 19 and the package
published in Task 21.

- [ ] **Step 1: Install the package** (the package itself creates `joysort` — Design decision 15)

```bash
ssh joysort@172.30.3.24 'lxc exec ompweb-test -- apt-get install -y omp-web'
```

Expected output includes `postinst`'s own log lines:
```
omp-web: account 'joysort' does not exist; creating it (unconditional fresh-install default, never $SUDO_USER — Design decision 10)
omp-web: installed bun ... at /home/joysort/.bun/bin/bun
omp-web: installed bundled omp ... at /home/joysort/.local/bin/omp
omp-web: wrote /home/joysort/omp/ops/env/5010.env (OMP_WEB_HOSTNAME=...)
omp-web: omp-web.service is active for joysort (port 5010)
```

- [ ] **Step 2: `joysort` account exists with expected home/shell/group** (addendum §4)

```bash
ssh joysort@172.30.3.24 'lxc exec ompweb-test -- getent passwd joysort'
ssh joysort@172.30.3.24 'lxc exec ompweb-test -- getent group joysort'
ssh joysort@172.30.3.24 'lxc exec ompweb-test -- loginctl show-user joysort -p Linger'
```

Expected: a passwd row with home `/home/joysort` and shell `/bin/bash`; a matching `joysort` private
group; `Linger=yes`.

- [ ] **Step 3: `omp-web.service` is enabled and active under `joysort`'s `systemd --user`**

```bash
ssh joysort@172.30.3.24 'lxc exec ompweb-test -- runuser -l joysort -c "systemctl --user is-enabled omp-web.service"'
ssh joysort@172.30.3.24 'lxc exec ompweb-test -- runuser -l joysort -c "systemctl --user is-active omp-web.service"'
```

Expected: `enabled`, `active`.

- [ ] **Step 4: Port 5010 is listening and reachable, authenticated `/api/health` returns healthy**

```bash
CONTAINER_PW="$(ssh joysort@172.30.3.24 'lxc exec ompweb-test -- grep OMP_WEB_PASSWORD /home/joysort/omp/ops/env/5010.env | cut -d= -f2-')"
curl -fsS -u "omp:${CONTAINER_PW}" http://172.30.3.24:5011/api/health | python3 -m json.tool
```

Expected: HTTP 200 with a JSON body containing a healthy status field, omp/omp-web versions, and
`terminals` reflecting `OMP_WEB_TERMINALS=1`. (This step reads the container's own env file over
`lxc exec`, not SSH, and passes the value straight into `curl -u` — never echoed on its own.)

- [ ] **Step 5: `/api/models` shows the expected provider/model set** (structural, not byte-identical,
  parity per Design decision 14)

```bash
curl -fsS -u "omp:${CONTAINER_PW}" http://172.30.3.24:5011/api/models | python3 -c '
import json, sys
data = json.load(sys.stdin)
providers = {m["provider"] for m in data.get("modelList", data.get("models", []))}
print(sorted(providers))
'
```

Expected: a list including `deepseek`, `bailian-cli`, `zhipu-coding-plan`, `agent-plan`,
`volcengine-plan`, `xai` — the expanded baseline (Design decision 14), not `.202`'s current
three-custom-provider snapshot.

- [ ] **Step 6: Terminal-tab functionality works (pty backend reachable)** — verified via the actual
  route, `GET /api/terminals/status` (plural), confirmed against `app/api/terminals/status/route.ts`

```bash
curl -fsS -u "omp:${CONTAINER_PW}" http://172.30.3.24:5011/api/terminals/status
curl -fsS -u "omp:${CONTAINER_PW}" http://172.30.3.24:5011/api/terminals/status | python3 -c 'import json,sys; assert json.load(sys.stdin)["enabled"] is True, "terminals not enabled"; print("TERMINALS_ENABLED_OK")'
```

Expected: `{"enabled":true}` followed by `TERMINALS_ENABLED_OK` — `OMP_WEB_TERMINALS=1` was set in
Step 1's env file, so `enabled` must be `true`, not merely a 200 status with an unchecked body.

- [ ] **Step 7: Bun is present and is the bundled version**

```bash
ssh joysort@172.30.3.24 'lxc exec ompweb-test -- runuser -l joysort -c "bun --version"'
```

Expected: matches the version captured at build time (`opt/omp-web/runtime/bun.version` inside the
`.deb`, e.g. `1.3.14`).

- [ ] **Step 8: `omp` CLI present and correctly resolved on two distinct PATHs** (addendum §8 — must
  check both the login PATH and the actual PATH the running service process sees, since these can
  differ)

```bash
ssh joysort@172.30.3.24 'lxc exec ompweb-test -- runuser -l joysort -c "command -v omp && omp --version"'

SERVICE_PID="$(ssh joysort@172.30.3.24 'lxc exec ompweb-test -- runuser -l joysort -c "systemctl --user show omp-web.service -p MainPID --value"')"
ssh joysort@172.30.3.24 "lxc exec ompweb-test -- cat /proc/${SERVICE_PID}/environ" | tr '\0' '\n' | grep '^PATH='
ssh joysort@172.30.3.24 "lxc exec ompweb-test -- runuser -l joysort -c 'PATH=\$(cat /proc/${SERVICE_PID}/environ | tr \"\\\\0\" \"\\\\n\" | grep ^PATH= | cut -d= -f2-) command -v omp'"
```

Expected: `command -v omp` resolves to `/home/joysort/.local/bin/omp` (the bundled binary, since this
is a fresh container with no pre-existing `omp`) and prints a version; the service process's
`/proc/<pid>/environ` `PATH=` line includes `/home/joysort/.local/bin`; re-resolving `omp` under that
exact `PATH` value also succeeds — both checks pass, confirming Design decision 11's "verify `omp
--version` via both the login PATH and the effective service PATH."

- [ ] **Step 9: `~/.omp/agent` state layout matches expectations**

```bash
ssh joysort@172.30.3.24 'lxc exec ompweb-test -- runuser -l joysort -c "ls -la ~/.omp/agent/"'
ssh joysort@172.30.3.24 'lxc exec ompweb-test -- runuser -l joysort -c "stat -c %a ~/.omp/agent/.env"'
ssh joysort@172.30.3.24 'lxc exec ompweb-test -- runuser -l joysort -c "cut -d= -f1 ~/.omp/agent/.env | grep -v \"^#\" | grep -v \"^\$\" | sort"'
```

Expected: `models.yml`, `config.yml`, `.env` present; `.env` mode `600`; key list is exactly:
```
AGENT_PLAN_API_KEY
BAILIAN_CLI_API_KEY
DEEPSEEK_API_KEY
VOLCENGINE_PLAN_API_KEY
XAI_API_KEY
ZHIPU_API_KEY
```
(`OMP_WEB_PASSWORD` correctly absent — kept out via `--skip-var` in `debian/postinst`'s
`seed_agent_dir`.)

- [ ] **Step 10: Confirm every explicitly prohibited fresh-LXC action was in fact never taken**
  (addendum §4's negative assertions)

```bash
echo "No manual useradd/groupadd before install: confirmed by Task 19 Step 4 + this task's Step 1 log (postinst's own useradd line, timestamped after apt install started)"
echo "No git clone of the app: confirmed — Task 19 provisioned only the apt source/key (Step 5), nothing else"
echo "No direct dpkg -i of a manually copied .deb: confirmed — Step 1 used 'apt-get install', which resolves and downloads from the configured apt source"
ssh joysort@172.30.3.24 'lxc exec ompweb-test -- test -d /root/.deb-manual-copy && echo UNEXPECTED || echo NO_MANUAL_DEB_COPY_OK'
```

Expected: `NO_MANUAL_DEB_COPY_OK`.

No commit — verification only.

---

## Task 23: Reinstall/upgrade non-destructiveness and crash-safe interrupted-install recovery

**Files:** none — verification only.

### Part A: full-state preservation across a normal reinstall (addendum §6)

- [ ] **Step 1: Seed a realistic `~/.omp/agent` tree covering every required category**

```bash
ssh joysort@172.30.3.24 'lxc exec ompweb-test -- runuser -l joysort -c "
  mkdir -p ~/.omp/agent/sessions ~/.omp/agent/skills ~/.omp/agent/plugins ~/.omp/agent/extensions ~/.omp/agent/memories ~/.omp/agent/uploads ~/.omp/agent/terminal
  echo session-jsonl-fixture > ~/.omp/agent/sessions/fixture-session.jsonl
  sqlite3 ~/.omp/agent/agent.db \"CREATE TABLE IF NOT EXISTS t(x); INSERT INTO t VALUES (1);\" 2>/dev/null || echo sqlite3-fixture > ~/.omp/agent/agent.db
  echo wal-fixture > ~/.omp/agent/agent.db-wal
  echo shm-fixture > ~/.omp/agent/agent.db-shm
  echo skill-fixture > ~/.omp/agent/skills/fixture.md
  echo plugin-fixture > ~/.omp/agent/plugins/fixture.json
  echo extension-fixture > ~/.omp/agent/extensions/fixture.json
  echo memory-fixture > ~/.omp/agent/memories/fixture.md
  echo upload-fixture > ~/.omp/agent/uploads/fixture.bin
  echo terminal-state-fixture > ~/.omp/agent/terminal/fixture.state
  echo machines-fixture > ~/.omp/agent/machines.json
  echo trust-fixture > ~/.omp/agent/trust.json
  mkdir -p ~/omp/ompweb/operator-added
  echo operator-fixture > ~/omp/ompweb/operator-added/note.txt
"'
```

- [ ] **Step 2: Capture checksums/sentinels of everything that must survive**

```bash
ssh joysort@172.30.3.24 'lxc exec ompweb-test -- runuser -l joysort -c "
  find ~/.omp/agent ~/omp/ops/env ~/.config/systemd/user/omp-web.service ~/omp/ompweb/operator-added -type f -exec sha256sum {} \;
" | sort' > /tmp/omp-web-preinstall-checksums.txt
wc -l /tmp/omp-web-preinstall-checksums.txt
```

Expected: at least 15 lines (one per fixture file plus the unit, env file, and pre-existing agent
config).

- [ ] **Step 3: Snapshot the running PID and start time**

```bash
ssh joysort@172.30.3.24 'lxc exec ompweb-test -- runuser -l joysort -c "systemctl --user show omp-web.service -p MainPID,ExecMainStartTimestamp"'
```

Record this output.

- [ ] **Step 4: Reinstall**

```bash
ssh joysort@172.30.3.24 'lxc exec ompweb-test -- apt-get install --reinstall -y omp-web'
```

Expected `postinst` output this time (upgrade path, not fresh-install): only
`omp-web: omp-web.service is active for joysort (port 5010)` — **no** `wrote .../5010.env`, **no**
`installed bun/omp` lines, **no** `account 'joysort' does not exist` line (the marker from Task 22 Step
1 is present, so this run takes the `else` branch in `debian/postinst`).

- [ ] **Step 5: Confirm every captured checksum is unchanged, and the service actually restarted**

```bash
ssh joysort@172.30.3.24 'lxc exec ompweb-test -- runuser -l joysort -c "
  find ~/.omp/agent ~/omp/ops/env ~/.config/systemd/user/omp-web.service ~/omp/ompweb/operator-added -type f -exec sha256sum {} \;
" | sort' > /tmp/omp-web-postinstall-checksums.txt
diff /tmp/omp-web-preinstall-checksums.txt /tmp/omp-web-postinstall-checksums.txt

ssh joysort@172.30.3.24 'lxc exec ompweb-test -- runuser -l joysort -c "systemctl --user show omp-web.service -p MainPID,ExecMainStartTimestamp"'
```

Expected: `diff` produces **no output** — every file's checksum (including the fixture data covering
credentials, DB/WAL/SHM, sessions, registries, skills/plugins/extensions/memories/uploads/terminal
state, plus the unit, env file, and the operator-added file under `~/omp/ompweb`) is byte-identical.
The `MainPID`/`ExecMainStartTimestamp` output shows a **different** PID and a **later** timestamp than
Step 3 — the restart happened (accepted per Design decision 12), it just didn't touch any of the
preserved state.

- [ ] **Step 6: Confirm health after reinstall**

```bash
curl -fsS -u "omp:${CONTAINER_PW}" http://172.30.3.24:5011/api/health | python3 -m json.tool
```

Expected: HTTP 200, healthy, same as Task 22 Step 4.

### Part B: crash-safe interrupted-install recovery (addendum §7)

- [ ] **Step 7: Purge the container back to a bare state and relaunch it** (a second, disposable
  container so Part A's fixture data isn't disturbed)

```bash
ssh joysort@172.30.3.24 'lxc delete ompweb-test --force'
ssh joysort@172.30.3.24 'lxc launch ubuntu:22.04 ompweb-crashtest -c limits.memory=4GiB -c limits.cpu=4'
ssh joysort@172.30.3.24 "lxc exec ompweb-crashtest -- mkdir -p /etc/apt/keyrings"
ssh joysort@172.30.3.24 "cat /etc/apt/keyrings/joysort-archive-keyring.gpg | lxc exec ompweb-crashtest -- tee /etc/apt/keyrings/joysort-archive-keyring.gpg > /dev/null"
ssh joysort@172.30.3.24 "cat /etc/apt/sources.list.d/joysort.sources | lxc exec ompweb-crashtest -- tee /etc/apt/sources.list.d/joysort.sources > /dev/null"
ssh joysort@172.30.3.24 "lxc exec ompweb-crashtest -- apt-get update -qq"
```

- [ ] **Step 8: Start the install, kill `postinst` partway through, before the completion marker**

```bash
ssh joysort@172.30.3.24 'lxc exec ompweb-crashtest -- bash -c "
  apt-get install -y --no-install-recommends omp-web &
  APT_PID=\$!
  # Poll for evidence postinst is mid-flight (agent dir created) but the
  # completion marker not yet written, then kill dpkg/postinst's process
  # group — simulates a host power-loss or OOM-kill mid-provisioning.
  for i in \$(seq 1 60); do
    if [ -d /home/joysort/.omp/agent ] && [ ! -f /home/joysort/.local/state/omp-web/install.complete ]; then
      pkill -9 -f debian/postinst || pkill -9 dpkg || true
      break
    fi
    sleep 0.2
  done
  wait \$APT_PID 2>/dev/null || true
"'
```

- [ ] **Step 9: Confirm the interruption actually happened before completion**

```bash
ssh joysort@172.30.3.24 'lxc exec ompweb-crashtest -- test -f /home/joysort/.local/state/omp-web/install.complete' \
  && echo "UNEXPECTED: install completed before the kill" || echo "CONFIRMED_INTERRUPTED_BEFORE_MARKER"
```

Expected: `CONFIRMED_INTERRUPTED_BEFORE_MARKER`. If the install raced ahead and completed before the
kill landed, re-run Step 7–8 (the polling loop in Step 8 is timing-sensitive on a fast container).

- [ ] **Step 10: Re-run `dpkg --configure` to trigger the crash-safe resume**

```bash
ssh joysort@172.30.3.24 'lxc exec ompweb-crashtest -- dpkg --configure omp-web'
```

Expected: `postinst` runs again, logs `omp-web: no completion marker at ... — running
fresh-install-or-resume (every step below is idempotent)`, and this time completes cleanly — ending
with `omp-web: omp-web.service is active for joysort (port 5010)`.

- [ ] **Step 11: Verify the resumed install converged to a fully-provisioned, correctly-marked state
  with no duplicate/corrupted artifacts**

```bash
ssh joysort@172.30.3.24 'lxc exec ompweb-crashtest -- runuser -l joysort -c "test -f ~/.local/state/omp-web/install.complete && echo MARKER_OK"'
ssh joysort@172.30.3.24 'lxc exec ompweb-crashtest -- runuser -l joysort -c "systemctl --user is-active omp-web.service"'
ssh joysort@172.30.3.24 'lxc exec ompweb-crashtest -- runuser -l joysort -c "grep -c \"^\\[Unit\\]\" ~/.config/systemd/user/omp-web.service"'
ssh joysort@172.30.3.24 'lxc exec ompweb-crashtest -- runuser -l joysort -c "find ~/.config/systemd/user -maxdepth 1 -name \"omp-web.service*\" | sort"'
ssh joysort@172.30.3.24 'lxc exec ompweb-crashtest -- runuser -l joysort -c "cut -d= -f1 ~/.omp/agent/.env | grep -v \"^#\" | grep -v \"^\$\" | sort | uniq -c | awk \"\\$1 != 1 { print }\""'
```

Expected: `MARKER_OK`; `active`; `1` (exactly one well-formed `[Unit]` section, not a truncated stub);
the `find` listing shows exactly one `omp-web.service` file (no `.dpkg-new`/duplicate leftovers from
the interrupted run); the final `awk` check prints **nothing** (no key appears more than once in
`.env` — confirms the resumed `seed_agent_dir` merge didn't duplicate entries).

```bash
ssh joysort@172.30.3.24 'lxc delete ompweb-crashtest --force'
```

No commit — verification only.

---

## Task 24: Fleet rollout (host-by-host, gateway last)

The six existing hosts (`172.30.3.{123,250,24,109,202,39}`, plus `172.30.3.110` over ZeroTier)
currently run from a hand-checked-out `~/omp/ompweb` git clone. Rolling `apt install omp-web` onto them
makes apt the source of truth for `~/omp/ompweb`'s contents going forward (Design decision 5 — a
non-destructive tar-pipe overlay, not `rsync --delete`), while leaving every host's existing
unit/env/agent-config completely untouched (they already exist, so `postinst` takes the upgrade path
immediately — Design decision 9).

**Files:** none — operational rollout, not repo content.

- [ ] **Step 1: One host at a time, starting with a remote, never the gateway first**

```bash
ssh joysort@172.30.3.24 'sudo apt-get update -qq && sudo apt-get install -y omp-web'
```

Repeat for `172.30.3.250`, `172.30.3.109`, `172.30.3.202` (never touch its unrelated pm2 apps),
`172.30.3.39`, and `172.30.3.110` (over ZeroTier, same command).

- [ ] **Step 2: After each host, confirm before moving to the next**

```bash
HOST=172.30.3.24
PASS="$(ssh joysort@"$HOST" 'sed -n "s/^OMP_WEB_PASSWORD=//p" ~/omp/ops/env/5010.env')"
curl -fsS -u "omp:${PASS}" "http://${HOST}:5010/api/health"
```

Expected: HTTP 200, healthy.

- [ ] **Step 3: Gateway (`172.30.3.123`) last, and only when no session is actively running through
  it**

```bash
gh api /repos/n0rthwood/omp-web/actions/runners --jq '.runners[] | select(.name=="omp-web-builder-123") | .busy'
```

Confirm `false` (the runner itself lives on the gateway box; restarting `omp-web.service` there does
not affect the Actions runner service, but it **does** kill any in-process `AgentSession` — accepted
per Design decision 12). Only then:

```bash
ssh joysort@172.30.3.123 'sudo apt-get update -qq && sudo apt-get install -y omp-web'
HOST=172.30.3.123
PASS="$(ssh joysort@"$HOST" 'sed -n "s/^OMP_WEB_PASSWORD=//p" ~/omp/ops/env/5010.env')"
curl -fsS -u "omp:${PASS}" "http://${HOST}:5010/api/health"
```

Expected: HTTP 200, healthy.

No commit — operational rollout, not repo content.

---

## Self-review

Performed against https://github.com/n0rthwood/omp-web/issues/25#issuecomment-5361386083 (the
addendum, §1–10) and https://github.com/n0rthwood/omp-web/issues/25#issuecomment-5362604376 (owner
inputs resolved):

- **§1 release flow**: tag format `omp-web-vX.Y.Z` (Task 2, Design decision 2), tag-triggered build
  (Task 14), tag version must equal `debian/changelog` (Task 14 Step 1), publish only via the canonical
  `update-apt-repo` action (Task 14, Design decision 7), post-publish apt-metadata verification (Task
  14's `publish` job last step), `apt install`/`apt install --reinstall` only (Tasks 22–23), no GitHub
  Release object/asset (Design decision 4), `workflow_dispatch` can never supersede a tagged production
  package (Task 14's job split + Task 21 Step 4's explicit proof) — covered.
- **§2 secrets split**: `GH_PAT` → real vars/secrets, canonical names, matching
  `/opt/workspace/joysort2026` (Task 17, Design decision 6); packaged runtime secrets stay
  XOR-obfuscated, missing-only merge, existing-wins (Tasks 4, 8, 11, 18) — covered. Cross-repo action
  access without a PAT resolved as an explicit GitHub-native prerequisite, not silently assumed (Task
  15, Design decision 8) — covered.
- **§3 target account**: `joysort` unconditional, never `$SUDO_USER`, full account creation on absence
  (Task 8, Design decision 10) — covered.
- **§4 fresh-LXC proof**: no pre-existing `joysort`, only apt source/key pre-provisioned, package
  creates the account, full verification checklist including terminals/bun/omp/state-layout (Tasks
  19–20, 22) — covered.
- **§5 `.202` parity**: structural/operational, not byte-identical; expanded baseline stated as the new
  seed (Tasks 5, 22 Step 5, Design decision 14) — covered.
- **§6 data preservation**: full `~/.omp/agent` tree (creds, DB/WAL/SHM, sessions, registries,
  skills/plugins/extensions/memories/uploads/terminal state) plus unit/env/operator files, proven by
  checksum diff, restart-interruption explicitly accepted (Task 23 Part A, Design decisions 12–13) —
  covered.
- **§7 crash-safe recovery**: dedicated marker (not unit presence), every fresh-install file write is
  atomic (`mktemp`+`mv`/`os.replace`), interrupted-install resume test with duplicate/corruption checks
  (Tasks 6, 8, 23 Part B, Design decision 9) — covered.
- **§8 `omp` CLI**: mandatory, full-login-PATH probe, preserved-if-found, postinst-only install,
  frozen-unit-plus-drop-in PATH strategy, dual-PATH verification via `/proc/<pid>/environ` (Tasks 7–8,
  22 Step 8, Design decision 11) — covered.
- **§9 runtime stack**: Bun/SDK remain load-bearing, `omp` is additional not substitutive (Design
  decision 16, File map) — covered.
- **§10 NO-GO items**: every numbered defect from the addendum is the reason a specific task/design
  decision in this revision exists, listed above — covered.
- **Owner-resolved inputs (2026-08-20T22:11 comment)**: `XAI_API_KEY` sourced locally (Task 18, no
  value ever printed), default web username `omp` recorded as non-secret (Task 8's `seed_env_file`),
  `OMP_WEB_PASSWORD` owner-supplied and local-only (Task 18), no GitHub Release (Design decision 4), no
  `GH_PAT` (Design decisions 6/8, Task 15), canonical `/opt/workspace/joysort2026` self-hosted
  build→R2-apt-publish shape followed (Task 14, grounded against `joysort-desktop`'s and `jsfb`'s live
  workflows plus `update-apt-repo/action.yml` itself) — covered.
- **Assignment-level constraints**: no PR, direct merge (Task 20); no code/infra/secret/host changes
  executed by this plan's author — every task that touches GitHub/runner/host state is written as
  operator-executable steps, not performed while authoring this document; no secret value appears
  anywhere in this document (grep-checked: every command that reads a plaintext value redirects
  straight to a file or `curl -u`, never `echo`s a value) — covered.
- **Placeholder scan**: every step shows concrete commands and expected output; no `TBD`, "implement
  later", or "add appropriate error handling" phrasing anywhere in this document — none found.
- **Type/name consistency check**: `resolve_target_user`, `sync_bun`, `resolve_or_install_omp`,
  `sync_app`, `write_fresh_unit`, `ensure_unit_path_covers_omp`, `seed_env_file`, `seed_agent_dir`,
  `write_marker` (Task 8) are used with identical names and signatures everywhere they're referenced
  (Task 6's fixture tests exercise the same script, not a restated copy); `tools/xor-secrets.py`'s
  `seal`/`merge`/`get` subcommand names and flags (`--plain`/`--out-cipher`/`--out-key`/`--cipher`/
  `--key`/`--target`/`--skip-var`/`--var`) are identical across Task 4, Task 6's fixture harness, Task
  8's `postinst`, and Task 11's `assemble-secrets.sh`/`build-deb.sh` — consistent throughout.
