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
  mkdir -p "$root/opt/omp-web/current" "$root/opt/omp-web/runtime" \
    "$root/opt/omp-web/config" "$root/opt/omp-web/systemd"
  cat > "$root/opt/omp-web/runtime/bun" <<'BUNEOF'
#!/bin/bash
# Fake bun: logs every invocation (so tests can assert install-call counts)
# and, for `install`, materializes a node_modules dir with a marker file —
# ensure_env's "does $env_dir/node_modules already exist" reuse check needs
# something real to observe across repeated fixture runs. Also simulates
# bun's patchedDependencies resolution: any patch file bun.lock references
# (a path relative to the install cwd) must exist, or a real `bun install
# --frozen-lockfile` fails with "Couldn't find patch file" — this is what
# catches ensure_env not having copied patches/ into env_dir alongside
# package.json/bun.lock.
echo "bun-fake $*" >> "${OMP_WEB_TEST_ROOT}/bun-install.log"
if [ "$1" = "install" ]; then
  if [ -f bun.lock ]; then
    for patch_path in $(grep -oE '"[^"]*\.patch"' bun.lock | tr -d '"'); do
      if [ ! -f "$patch_path" ]; then
        echo "bun-fake: error: Couldn't find patch file \"$patch_path\"" >&2
        exit 1
      fi
    done
  fi
  mkdir -p node_modules
  touch node_modules/.fixture-installed
fi
BUNEOF
  printf '#!/bin/bash\necho omp-fake "$@"\n' > "$root/opt/omp-web/runtime/omp"
  chmod +x "$root/opt/omp-web/runtime/bun" "$root/opt/omp-web/runtime/omp"
  echo "1.3.14" > "$root/opt/omp-web/runtime/bun.version"
  echo "17.3.4" > "$root/opt/omp-web/runtime/omp.version"
  printf 'modelRoles:\n  plan: {}\n' > "$root/opt/omp-web/config/config.yml.default"
  printf 'providers:\n  deepseek: {}\n' > "$root/opt/omp-web/config/models.yml.default"
  cp "$REPO_ROOT/release/systemd/omp-web.service" "$root/opt/omp-web/systemd/omp-web.service"
  printf '{\n  "name": "omp-web-fixture",\n  "version": "0.0.0"\n}\n' \
    > "$root/opt/omp-web/current/package.json"
  printf '{\n  "lockfileVersion": 1,\n  "packages": {}\n}\n' \
    > "$root/opt/omp-web/current/bun.lock"
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

# --- fake omp-web, for the joysortmain bootstrap tests (#75) -------------
# Speaks just enough of the real API: the auth-exempt readiness probe, the
# admin-only create (with the real 400 "Username already exists" shape), and
# the delete the rollback path uses. Binds an EPHEMERAL port, so a test can
# never talk to whatever is really listening on :5010 on this machine.
FAKE_SERVER="$(mktemp "${TMPDIR:-/tmp}/omp-web-fake-server.XXXXXX.py")"
cat > "$FAKE_SERVER" <<'SERVEREOF'
import base64
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PASSWORD, PORT_FILE, LOG_FILE = sys.argv[1], sys.argv[2], sys.argv[3]
USERS = set(name for name in sys.argv[4:] if name)
EXPECTED = "Basic " + base64.b64encode(("omp:" + PASSWORD).encode()).decode()


def log(line):
    with open(LOG_FILE, "a") as handle:
        handle.write(line + "\n")


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/auth/web-me":
            self.reply(200, {"user": None})
        else:
            self.reply(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/api/web-users":
            self.reply(404, {"error": "Not found"})
            return
        if self.headers.get("Authorization") != EXPECTED:
            log("REJECTED-AUTH")
            self.reply(401, {"error": "Authentication required"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        name = body.get("username", "")
        if name in USERS:
            log("CONFLICT " + name)
            self.reply(400, {"error": "Username already exists"})
            return
        USERS.add(name)
        log("CREATED %s role=%s projects=%s" % (name, body.get("role"), body.get("projects")))
        self.reply(201, {"user": {"username": name}})

    def do_DELETE(self):
        USERS.discard(self.path.rsplit("/", 1)[-1])
        log("DELETED " + self.path.rsplit("/", 1)[-1])
        self.reply(200, {"success": True})

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
with open(PORT_FILE, "w") as handle:
    handle.write(str(server.server_address[1]))
server.serve_forever()
SERVEREOF

# start_fake_ompweb runs inside a command substitution (a subshell), so the
# launched pids have to be recorded in a FILE — an array assignment there
# would be invisible to this shell and every server would outlive the run.
FAKE_PIDS_FILE="$(mktemp "${TMPDIR:-/tmp}/omp-web-fake-pids.XXXXXX")"
cleanup_fakes() {
  while read -r pid; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done < "$FAKE_PIDS_FILE"
  rm -f "$FAKE_SERVER" "$FAKE_PIDS_FILE"
}
trap cleanup_fakes EXIT

# start_fake_ompweb ROOT PASSWORD [already-existing-username...] -> base URL
start_fake_ompweb() {
  local root="$1" password="$2"; shift 2
  local port_file="$root/fake-port"
  rm -f "$port_file" "$root/fake-api.log"
  # Detach stdout/stderr: this function's result is read through a command
  # substitution, which blocks until every writer to that pipe is gone — a
  # background server inheriting it would hang the suite forever.
  python3 "$FAKE_SERVER" "$password" "$port_file" "$root/fake-api.log" "$@" \
    >/dev/null 2>&1 &
  echo "$!" >> "$FAKE_PIDS_FILE"
  local waited=0
  while [ ! -s "$port_file" ]; do
    sleep 0.1
    waited=$((waited + 1))
    if [ "$waited" -gt 100 ]; then
      echo "FAIL - fake omp-web never bound a port"
      FAIL=1
      return 1
    fi
  done
  echo "http://127.0.0.1:$(cat "$port_file")"
}

# Pre-creates the target user and a 5010.env holding a KNOWN password, so a
# test can stand up a fake omp-web that accepts exactly that credential.
# seed_env_file leaves an existing env file alone, so postinst then uses it.
seed_known_env() {
  local root="$1" password="$2" quoted="${3:-}"
  PATH="$HERE/fixtures/bin:$PATH" OMP_WEB_TEST_ROOT="$root" \
    "$HERE/fixtures/bin/useradd" -m -s /bin/bash joysort
  mkdir -p "$root/home/joysort/omp/ops/env"
  {
    echo "OMP_WEB_HOSTNAME=10.0.0.99"
    echo "OMP_WEB_USERNAME=omp"
    if [ -n "$quoted" ]; then
      echo "OMP_WEB_PASSWORD=\"$password\""
    else
      echo "OMP_WEB_PASSWORD=$password"
    fi
    echo "OMP_WEB_TERMINALS=1"
  } > "$root/home/joysort/omp/ops/env/5010.env"
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
AGENT_ENV_BYTES="$(stat -c '%s' "$HOME1/.omp/agent/.env")"
assert_eq "fresh install: agent .env created empty — no provider key ships in the package (#74)" \
  "0" "$AGENT_ENV_BYTES"
assert_eq "fresh install: agent .env is 0600" "600" "$(stat -c '%a' "$HOME1/.omp/agent/.env")"
PW1="$(grep '^OMP_WEB_PASSWORD=' "$HOME1/omp/ops/env/5010.env" | cut -d= -f2-)"
assert_eq "fresh install: web password is a generated token_urlsafe(32) value" "43" "${#PW1}"
assert_eq "fresh install: web password written unquoted" \
  "0" "$(grep -c '^OMP_WEB_PASSWORD="' "$HOME1/omp/ops/env/5010.env" || true)"
assert_eq "fresh install: password kept out of agent .env" \
  "0" "$(grep -c OMP_WEB_PASSWORD "$HOME1/.omp/agent/.env" || true)"

# --- Test 3: re-running the install is idempotent and never touches the
# operator's own secrets — a deployed host's agent .env holds live, possibly
# just-rotated provider keys, and its 5010.env holds the only copy of that
# machine's web password ---
printf 'DEEPSEEK_API_KEY=operator-rotated-value\n' > "$HOME1/.omp/agent/.env"
AGENT_ENV_SUM_BEFORE="$(sha256sum "$HOME1/.omp/agent/.env" | cut -d' ' -f1)"
run_postinst "$ROOT1"
AGENT_ENV_SUM_AFTER="$(sha256sum "$HOME1/.omp/agent/.env" | cut -d' ' -f1)"
assert_eq "idempotent re-run: operator's agent .env byte-identical" \
  "$AGENT_ENV_SUM_BEFORE" "$AGENT_ENV_SUM_AFTER"
assert_eq "idempotent re-run: generated web password preserved" \
  "$PW1" "$(grep '^OMP_WEB_PASSWORD=' "$HOME1/omp/ops/env/5010.env" | cut -d= -f2-)"
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
PW4="$(grep '^OMP_WEB_PASSWORD=' "$HOME4/omp/ops/env/5010.env" | cut -d= -f2-)"
assert_eq "fresh install: every machine gets its own web password, never a packaged one (#74)" \
  "1" "$( [ -n "$PW4" ] && [ "$PW1" != "$PW4" ] && echo 1 || echo 0 )"
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

# --- Test 8: resume re-seeds env before restarting a still-active service ---
# A kill after `enable --now` but before `write_marker` leaves the service
# running with the marker absent; if the env file is then missing, the resume
# path must re-seed it BEFORE sync_app restarts the service (regression: the
# original order restarted first and the start failed on the missing env file).
ROOT8="$(new_fixture_root)"
build_fake_payload "$ROOT8"
run_postinst "$ROOT8"
HOME8="$ROOT8/home/joysort"
printf 'ZHIPU_API_KEY=live-key-on-this-host\n' > "$HOME8/.omp/agent/.env"
AGENT_ENV_SUM_BEFORE8="$(sha256sum "$HOME8/.omp/agent/.env" | cut -d' ' -f1)"
rm -f "$HOME8/.local/state/omp-web/install.complete"
rm -f "$HOME8/omp/ops/env/5010.env"
run_postinst "$ROOT8"
assert_eq "resume: operator's agent .env survives the marker-absent path" \
  "$AGENT_ENV_SUM_BEFORE8" "$(sha256sum "$HOME8/.omp/agent/.env" | cut -d' ' -f1)"
assert_file_exists "resume: env file re-seeded before restart" "$HOME8/omp/ops/env/5010.env"
assert_file_exists "resume: marker re-written after resume" "$HOME8/.local/state/omp-web/install.complete"
assert_eq "resume: service still active after re-seed+restart" "active" "$(cat "$ROOT8/omp-web.service.state")"

# --- Test 9: ensure_env materializes a bun.lock-hash-keyed env dir on
# fresh install and symlinks $DEST/node_modules into it (refs #43) ---
ROOT9="$(new_fixture_root)"
build_fake_payload "$ROOT9"
run_postinst "$ROOT9"
HOME9="$ROOT9/home/joysort"
ENV_HASH9="$(sha256sum "$ROOT9/opt/omp-web/current/bun.lock" | cut -c1-16)"
ENV_DIR9="$HOME9/omp/envs/$ENV_HASH9"
assert_file_exists "ensure_env: fresh install materializes node_modules in the hashed env dir" \
  "$ENV_DIR9/node_modules/.fixture-installed"
assert_file_exists "ensure_env: env dir keeps its own copy of package.json" "$ENV_DIR9/package.json"
assert_file_exists "ensure_env: env dir keeps its own copy of bun.lock" "$ENV_DIR9/bun.lock"
SYMLINK_TARGET9="$(readlink "$HOME9/omp/ompweb/node_modules")"
assert_eq "ensure_env: DEST/node_modules symlinks into the hashed env dir" \
  "$ENV_DIR9/node_modules" "$SYMLINK_TARGET9"
INSTALL_COUNT9="$(grep -c '^bun-fake install' "$ROOT9/bun-install.log" || true)"
assert_eq "ensure_env: bun install invoked exactly once on first materialization" "1" "$INSTALL_COUNT9"

# --- Test 10: unchanged bun.lock on a repeat run reuses the env dir and
# skips `bun install` entirely ---
run_postinst "$ROOT9"
INSTALL_COUNT10="$(grep -c '^bun-fake install' "$ROOT9/bun-install.log" || true)"
assert_eq "ensure_env: unchanged bun.lock skips reinstall on a second run" "1" "$INSTALL_COUNT10"

# --- Test 11: a changed bun.lock (new release, different dependency set)
# materializes a distinct new env dir, reinstalls into it, retargets the
# symlink, and never deletes the previous release's still-referenced env
# dir ---
echo '  "extra-dep-changes-the-hash": true' >> "$ROOT9/opt/omp-web/current/bun.lock"
NEW_ENV_HASH11="$(sha256sum "$ROOT9/opt/omp-web/current/bun.lock" | cut -c1-16)"
run_postinst "$ROOT9"
NEW_ENV_DIR11="$HOME9/omp/envs/$NEW_ENV_HASH11"
assert_file_exists "ensure_env: changed bun.lock materializes a new distinct env dir" \
  "$NEW_ENV_DIR11/node_modules/.fixture-installed"
NEW_SYMLINK_TARGET11="$(readlink "$HOME9/omp/ompweb/node_modules")"
assert_eq "ensure_env: symlink retargeted to the new env dir after a bun.lock change" \
  "$NEW_ENV_DIR11/node_modules" "$NEW_SYMLINK_TARGET11"
OLD_ENV_STILL_PRESENT11="$( [ -d "$ENV_DIR9/node_modules" ] && echo 1 || echo 0 )"
assert_eq "ensure_env: previous release's env dir is preserved, not deleted" "1" "$OLD_ENV_STILL_PRESENT11"
INSTALL_COUNT11="$(grep -c '^bun-fake install' "$ROOT9/bun-install.log" || true)"
assert_eq "ensure_env: bun install invoked again for the new distinct lockfile hash" "2" "$INSTALL_COUNT11"

# --- Test 12: a stale .next/cache left by a pre-#43 full-tree tar-overlay
# is reclaimed on the next sync_app() overlay ---
mkdir -p "$HOME9/omp/ompweb/.next/cache"
echo "stale-build-cache" > "$HOME9/omp/ompweb/.next/cache/webpack-fixture-artifact"
run_postinst "$ROOT9"
STALE_CACHE_GONE12="$( [ -d "$HOME9/omp/ompweb/.next/cache" ] && echo 0 || echo 1 )"
assert_eq "sync_app: stale .next/cache reclaimed on overlay" "1" "$STALE_CACHE_GONE12"

# --- Test 13: a pre-existing host on the OLD (pre-#43) package has a REAL
# (non-symlink) node_modules directory at $DEST — every currently-deployed
# fleet host is in exactly this state on its first upgrade to this
# package. `ln -sfn` against an existing real directory nests the new
# symlink inside it instead of replacing it, so ensure_env must remove the
# real directory first. ---
REAL_NM13="$HOME9/omp/ompweb/node_modules"
rm -f "$REAL_NM13"
mkdir -p "$REAL_NM13"
echo "pre-#43-real-install" > "$REAL_NM13/legacy-marker.txt"
run_postinst "$ROOT9"
LEGACY_MARKER_GONE13="$( [ -f "$REAL_NM13/legacy-marker.txt" ] && echo 0 || echo 1 )"
assert_eq "ensure_env: pre-existing real node_modules content is removed, not nested under" "1" "$LEGACY_MARKER_GONE13"
IS_SYMLINK13="$( [ -L "$REAL_NM13" ] && echo 1 || echo 0 )"
assert_eq "ensure_env: DEST/node_modules is a symlink after upgrading a legacy real directory" "1" "$IS_SYMLINK13"
SYMLINK_TARGET13="$(readlink "$REAL_NM13")"
CURRENT_ENV_HASH13="$(sha256sum "$ROOT9/opt/omp-web/current/bun.lock" | cut -c1-16)"
assert_eq "ensure_env: legacy-host symlink points at the correct hashed env dir" \
  "$HOME9/omp/envs/$CURRENT_ENV_HASH13/node_modules" "$SYMLINK_TARGET13"

# --- Test 14: ensure_env must copy the package's patches/ directory into
# env_dir before running `bun install --frozen-lockfile`, or a bun.lock
# patchedDependencies entry (a path relative to the install cwd, e.g.
# "patches/@scope%2Fpkg@1.0.0.patch") cannot resolve and a real `bun
# install` fails with "Couldn't find patch file". ensure_env is brand new
# in this release, so every currently-deployed fleet host hits this on its
# very first upgrade — regression test for the fix on top of #43. ---
ROOT14="$(new_fixture_root)"
build_fake_payload "$ROOT14"
mkdir -p "$ROOT14/opt/omp-web/current/patches"
echo "fixture-patch-marker" > "$ROOT14/opt/omp-web/current/patches/fixture.patch"
cat > "$ROOT14/opt/omp-web/current/bun.lock" <<'EOF'
{
  "lockfileVersion": 1,
  "packages": {},
  "patchedDependencies": {
    "@oh-my-pi/pi-coding-agent@17.3.0": "patches/fixture.patch"
  }
}
EOF
if ! run_postinst "$ROOT14" >"$ROOT14/postinst.log" 2>&1; then
  echo "FAIL - ensure_env: postinst must succeed when bun.lock references patchedDependencies and the package ships patches/"
  cat "$ROOT14/postinst.log"
  FAIL=1
else
  HOME14="$ROOT14/home/joysort"
  ENV_HASH14="$(sha256sum "$ROOT14/opt/omp-web/current/bun.lock" | cut -c1-16)"
  ENV_DIR14="$HOME14/omp/envs/$ENV_HASH14"
  assert_file_exists "ensure_env: patches/ directory copied into env dir so bun install can resolve patchedDependencies" \
    "$ENV_DIR14/patches/fixture.patch"
  assert_file_exists "ensure_env: bun install succeeded (patchedDependencies resolved) leaving node_modules materialized" \
    "$ENV_DIR14/node_modules/.fixture-installed"
fi

# --- Test 15: on a host that also runs joysortmain, the fresh install hands
# joysortmain its own omp-web administrator (#75). Without this, joysortmain
# can never bootstrap itself: the env password lives in a file its service
# user cannot read, so its own POST /api/web-users gets a 403 forever. ---
ROOT15="$(new_fixture_root)"
build_fake_payload "$ROOT15"
mkdir -p "$ROOT15/var/lib/joysortmain"
KNOWN_PW15="fixture-web-password-fifteen"
seed_known_env "$ROOT15" "$KNOWN_PW15"
HOME15="$ROOT15/home/joysort"
OMP_WEB_TEST_BASE_URL="$(start_fake_ompweb "$ROOT15" "$KNOWN_PW15")"
export OMP_WEB_TEST_BASE_URL
run_postinst "$ROOT15"
STORE15="$ROOT15/var/lib/joysortmain/omp_credentials.json"
assert_file_exists "joysortmain bootstrap: credential store written" "$STORE15"
assert_eq "joysortmain bootstrap: credential store is 0600" \
  "600" "$(stat -c '%a' "$STORE15" 2>/dev/null || echo missing)"
assert_eq "joysortmain bootstrap: creates exactly the joysortmain-admin account" \
  "1" "$(grep -c '^CREATED joysortmain-admin role=admin projects=\*$' "$ROOT15/fake-api.log" || true)"
assert_eq "joysortmain bootstrap: never sends a credential omp-web rejects" \
  "0" "$(grep -c '^REJECTED-AUTH$' "$ROOT15/fake-api.log" || true)"
# One assertion pins the whole schema joysortmain's _load_store() reads, and
# that the handed-over password is a fresh token — never the omp password.
assert_eq "joysortmain bootstrap: store matches joysortmain's schema and never carries the omp password" \
  "1 joysortmain-admin 43 True True {}" \
  "$(python3 -c 'import json,sys
s = json.load(open(sys.argv[1]))
a = s["admin"]
print(s["version"], a["username"], len(a["password"]), a["password"] != sys.argv[2], bool(a["created"]), s["users"])' \
    "$STORE15" "$KNOWN_PW15")"
assert_file_exists "joysortmain bootstrap: install still completes (marker written)" \
  "$HOME15/.local/state/omp-web/install.complete"

# --- Test 16: a resumed install (marker absent) must never reset an account
# joysortmain already holds — a second create would hand joysortmain a
# password omp-web no longer has, or lock it out entirely ---
STORE_SUM16="$(sha256sum "$STORE15" | cut -d' ' -f1)"
rm -f "$HOME15/.local/state/omp-web/install.complete"
run_postinst "$ROOT15"
assert_eq "joysortmain bootstrap: existing credential untouched on a resume" \
  "$STORE_SUM16" "$(sha256sum "$STORE15" | cut -d' ' -f1)"
assert_eq "joysortmain bootstrap: a resume creates no second account" \
  "1" "$(grep -c '^CREATED ' "$ROOT15/fake-api.log" || true)"
unset OMP_WEB_TEST_BASE_URL

# --- Test 17: an account that already exists on the omp-web side (created by
# a human, or by a joysortmain whose store was lost) is left exactly as it
# is — never reset, and never recorded with a password that would not work ---
ROOT17="$(new_fixture_root)"
build_fake_payload "$ROOT17"
mkdir -p "$ROOT17/var/lib/joysortmain"
KNOWN_PW17="fixture-web-password-seventeen"
seed_known_env "$ROOT17" "$KNOWN_PW17"
OMP_WEB_TEST_BASE_URL="$(start_fake_ompweb "$ROOT17" "$KNOWN_PW17" joysortmain-admin)"
export OMP_WEB_TEST_BASE_URL
run_postinst "$ROOT17"
unset OMP_WEB_TEST_BASE_URL
assert_eq "joysortmain bootstrap: conflict observed on the omp-web side" \
  "1" "$(grep -c '^CONFLICT joysortmain-admin$' "$ROOT17/fake-api.log" || true)"
assert_eq "joysortmain bootstrap: a conflicting account writes no credential store" \
  "0" "$( [ -e "$ROOT17/var/lib/joysortmain/omp_credentials.json" ] && echo 1 || echo 0 )"
assert_file_exists "joysortmain bootstrap: a conflict still completes the install" \
  "$ROOT17/home/joysort/.local/state/omp-web/install.complete"

# --- Test 18: hosts seeded before #74 carry OMP_WEB_PASSWORD with literal
# quotes (systemd strips them when it loads the EnvironmentFile), so the
# bootstrap must strip them too or it authenticates with the wrong secret ---
ROOT18="$(new_fixture_root)"
build_fake_payload "$ROOT18"
mkdir -p "$ROOT18/var/lib/joysortmain"
KNOWN_PW18="fixture-web-password-eighteen"
seed_known_env "$ROOT18" "$KNOWN_PW18" quoted
OMP_WEB_TEST_BASE_URL="$(start_fake_ompweb "$ROOT18" "$KNOWN_PW18")"
export OMP_WEB_TEST_BASE_URL
run_postinst "$ROOT18"
unset OMP_WEB_TEST_BASE_URL
assert_eq "joysortmain bootstrap: legacy quoted OMP_WEB_PASSWORD still authenticates" \
  "1" "$(grep -c '^CREATED joysortmain-admin ' "$ROOT18/fake-api.log" || true)"
assert_eq "joysortmain bootstrap: legacy quoted password is never sent with its quotes" \
  "0" "$(grep -c '^REJECTED-AUTH$' "$ROOT18/fake-api.log" || true)"

# --- Test 19: the bootstrap is an addition, not a precondition — a broken
# credential store must neither be overwritten nor fail `apt install` ---
ROOT19="$(new_fixture_root)"
build_fake_payload "$ROOT19"
mkdir -p "$ROOT19/var/lib/joysortmain"
printf 'this is not json\n' > "$ROOT19/var/lib/joysortmain/omp_credentials.json"
KNOWN_PW19="fixture-web-password-nineteen"
seed_known_env "$ROOT19" "$KNOWN_PW19"
OMP_WEB_TEST_BASE_URL="$(start_fake_ompweb "$ROOT19" "$KNOWN_PW19")"
export OMP_WEB_TEST_BASE_URL
if run_postinst "$ROOT19"; then
  assert_eq "joysortmain bootstrap: an unreadable store never fails the install" "0" "0"
else
  assert_eq "joysortmain bootstrap: an unreadable store never fails the install" "0" "1"
fi
unset OMP_WEB_TEST_BASE_URL
assert_eq "joysortmain bootstrap: an unreadable store is left byte-identical" \
  "this is not json" "$(cat "$ROOT19/var/lib/joysortmain/omp_credentials.json")"
# The log file is absent precisely because the bootstrap made no request at
# all — it refuses to touch omp-web before it knows the store is usable.
assert_eq "joysortmain bootstrap: no account is created while the store is unusable" \
  "0" "$(grep -c '^CREATED ' "$ROOT19/fake-api.log" 2>/dev/null || echo 0)"
assert_file_exists "joysortmain bootstrap: install completes despite the broken store" \
  "$ROOT19/home/joysort/.local/state/omp-web/install.complete"

echo "---"
if [ "$FAIL" = "1" ]; then
  echo "FIXTURE TESTS FAILED"
  exit 1
fi
echo "ALL FIXTURE TESTS PASSED"
