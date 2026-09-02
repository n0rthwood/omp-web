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
  cat > "$root/opt/omp-web/runtime/bun" <<'BUNEOF'
#!/bin/bash
# Fake bun: logs every invocation (so tests can assert install-call counts)
# and, for `install`, materializes a node_modules dir with a marker file —
# ensure_env's "does $env_dir/node_modules already exist" reuse check needs
# something real to observe across repeated fixture runs.
echo "bun-fake $*" >> "${OMP_WEB_TEST_ROOT}/bun-install.log"
if [ "$1" = "install" ]; then
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

# --- Test 8: resume re-seeds env before restarting a still-active service ---
# A kill after `enable --now` but before `write_marker` leaves the service
# running with the marker absent; if the env file is then missing, the resume
# path must re-seed it BEFORE sync_app restarts the service (regression: the
# original order restarted first and the start failed on the missing env file).
ROOT8="$(new_fixture_root)"
build_fake_payload "$ROOT8"
run_postinst "$ROOT8"
HOME8="$ROOT8/home/joysort"
rm -f "$HOME8/.local/state/omp-web/install.complete"
rm -f "$HOME8/omp/ops/env/5010.env"
run_postinst "$ROOT8"
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
echo "---"
if [ "$FAIL" = "1" ]; then
  echo "FIXTURE TESTS FAILED"
  exit 1
fi
echo "ALL FIXTURE TESTS PASSED"
