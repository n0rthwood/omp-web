#!/usr/bin/env bash
# tests/retry-build-wrapper-tests.sh — synthetic tests for
# debian/retry-build.sh (omp-web#41). Proves the output-inactivity
# stall-detection/retry logic itself works — a hang case and a
# slow-but-progressing case — without relying on a real, expensive
# ~14-29+ min `next build` run as the only signal.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
WRAPPER="$REPO_ROOT/debian/retry-build.sh"

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

FIXTURES="$(mktemp -d "${TMPDIR:-/tmp}/omp-web-retry-build-fixtures.XXXXXX")"
trap 'rm -rf "$FIXTURES"' EXIT

write_fixture() {
  local name="$1"
  cat >"$FIXTURES/$name"
  chmod +x "$FIXTURES/$name"
}

# --- Fixture: hangs dead forever, spawns a grandchild worker, no output ---
write_fixture hang.sh <<'EOF'
#!/usr/bin/env bash
echo "hang: starting"
( sleep 999999 & wait ) &
echo "hang: worker spawned, now silent forever"
sleep 999999
EOF

# --- Fixture: slow but keeps producing output, then succeeds ---
write_fixture slow_progress.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for i in $(seq 1 6); do
  echo "slow: step $i/6"
  sleep 1
done
exit 0
EOF

# --- Fixture: never stalls, but never finishes either ---
write_fixture never_finishes.sh <<'EOF'
#!/usr/bin/env bash
while true; do
  echo "tick $(date +%s)"
  sleep 1
done
EOF

# --- Fixture: stalls on attempt 1, succeeds on attempt 2 — the actual
# observed shape of the real flake — and asserts the wrapper cleared
# $FLAKY_CLEAN_DIR (left by attempt 1) before invoking attempt 2. ---
write_fixture flaky_then_ok.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
COUNTER_FILE="${FLAKY_COUNTER_FILE:?}"
CLEAN_DIR="${FLAKY_CLEAN_DIR:?}"
count=0
[ -f "$COUNTER_FILE" ] && count=$(cat "$COUNTER_FILE")
count=$((count + 1))
echo "$count" >"$COUNTER_FILE"
echo "flaky: attempt #$count starting"
if [ "$count" -eq 1 ]; then
  mkdir -p "$CLEAN_DIR"
  echo "stale" >"$CLEAN_DIR/partial.marker"
  echo "flaky: attempt #$count left partial state, now silent forever"
  sleep 999999
fi
if [ -e "$CLEAN_DIR" ]; then
  echo "flaky: FAIL - partial state not cleared before attempt #$count" >&2
  exit 1
fi
echo "flaky: attempt #$count succeeding"
exit 0
EOF

# Runs the wrapper with output captured to $1, prints the exit status to
# stdout (captured by the caller) without tripping `set -e` on a nonzero
# wrapper exit — a wrapper failure is an expected outcome in some tests.
run_wrapper() {
  local outfile="$1"
  shift
  local status=0
  "$WRAPPER" "$@" >"$outfile" 2>&1 || status=$?
  echo "$status"
}

# === Test 1: a genuinely stalled command is detected, killed (including its
# grandchild worker), retried, and the wrapper ultimately reports failure
# after exhausting attempts — well under the job's blunt total timeout. ===
OUT1="$(mktemp)"
before_procs="$(pgrep -c -f 'sleep 999999' 2>/dev/null || true)"
START=$(date +%s)
STATUS1=$(
  BUILD_STALL_TIMEOUT_SECS=2 BUILD_ATTEMPT_HARD_CAP_SECS=30 \
    BUILD_MAX_ATTEMPTS=2 BUILD_POLL_INTERVAL_SECS=1 \
    run_wrapper "$OUT1" -- "$FIXTURES/hang.sh"
)
END=$(date +%s)
sleep 1 # let the just-killed process tree actually exit
after_procs="$(pgrep -c -f 'sleep 999999' 2>/dev/null || true)"
assert_eq "hang: wrapper fails after exhausting attempts" "1" "$([ "$STATUS1" -ne 0 ] && echo 1 || echo 0)"
assert_eq "hang: detected+retried well under a blunt total timeout" "1" "$([ "$((END - START))" -lt 30 ] && echo 1 || echo 0)"
assert_eq "hang: no leftover grandchild process after kill" "${before_procs:-0}" "${after_procs:-0}"
STALL_MSGS="$(grep -c 'no output for' "$OUT1" || true)"
assert_eq "hang: wrapper logged a stall detection" "1" "$([ "$STALL_MSGS" -ge 1 ] && echo 1 || echo 0)"

# === Test 2: a slow-but-progressing command (output more often than the
# stall window, total runtime longer than the stall window) is never killed
# and completes successfully — the acceptance criterion that matters most:
# a legitimate 14-29+ min build must never be false-failed. ===
OUT2="$(mktemp)"
STATUS2=$(
  BUILD_STALL_TIMEOUT_SECS=3 BUILD_ATTEMPT_HARD_CAP_SECS=30 \
    BUILD_MAX_ATTEMPTS=3 BUILD_POLL_INTERVAL_SECS=1 \
    run_wrapper "$OUT2" -- "$FIXTURES/slow_progress.sh"
)
assert_eq "slow-progress: never killed, wrapper succeeds" "0" "$STATUS2"
KILLED_MSGS="$(grep -c 'killed —' "$OUT2" || true)"
assert_eq "slow-progress: no stall/hard-cap kill logged" "0" "$KILLED_MSGS"

# === Test 3: a command that never stalls (keeps producing output) but never
# finishes is bounded by the per-attempt hard cap as a safety net,
# independent of stall detection, and the wrapper fails after exhausting
# attempts. ===
OUT3="$(mktemp)"
STATUS3=$(
  BUILD_STALL_TIMEOUT_SECS=100 BUILD_ATTEMPT_HARD_CAP_SECS=3 \
    BUILD_MAX_ATTEMPTS=2 BUILD_POLL_INTERVAL_SECS=1 \
    run_wrapper "$OUT3" -- "$FIXTURES/never_finishes.sh"
)
assert_eq "hard-cap: wrapper fails after exhausting attempts" "1" "$([ "$STATUS3" -ne 0 ] && echo 1 || echo 0)"
CAP_MSGS="$(grep -c 'exceeded hard cap' "$OUT3" || true)"
assert_eq "hard-cap: wrapper logged a hard-cap kill (not a stall)" "1" "$([ "$CAP_MSGS" -ge 1 ] && echo 1 || echo 0)"

# === Test 4: the real recurring shape of the actual flake — an attempt
# stalls once, gets killed, partial state ($BUILD_RETRY_CLEAN_PATHS, e.g.
# `.next`) is cleared, and the retried attempt succeeds; the wrapper as a
# whole reports success — this is the primary self-heal behavior #41 asks
# for: no human/agent needs to notice and manually rerun the workflow. ===
COUNTER_FILE="$(mktemp -u)"
CLEAN_DIR="$(mktemp -d)/next-equivalent"
OUT4="$(mktemp)"
STATUS4=$(
  BUILD_STALL_TIMEOUT_SECS=2 BUILD_ATTEMPT_HARD_CAP_SECS=30 \
    BUILD_MAX_ATTEMPTS=3 BUILD_POLL_INTERVAL_SECS=1 \
    BUILD_RETRY_CLEAN_PATHS="$CLEAN_DIR" \
    FLAKY_COUNTER_FILE="$COUNTER_FILE" FLAKY_CLEAN_DIR="$CLEAN_DIR" \
    run_wrapper "$OUT4" -- "$FIXTURES/flaky_then_ok.sh"
)
assert_eq "flaky-then-ok: wrapper self-heals within the same run" "0" "$STATUS4"
assert_eq "flaky-then-ok: took exactly one retry (2 attempts)" "2" "$(cat "$COUNTER_FILE")"
assert_eq "flaky-then-ok: partial state cleaned before the successful retry" "0" "$([ -e "$CLEAN_DIR" ] && echo 1 || echo 0)"

echo "---"
if [ "$FAIL" = "1" ]; then
  echo "SOME RETRY-BUILD WRAPPER TESTS FAILED"
  exit 1
fi
echo "ALL RETRY-BUILD WRAPPER TESTS PASSED"
