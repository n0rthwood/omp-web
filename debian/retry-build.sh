#!/usr/bin/env bash
# debian/retry-build.sh — bounded-retry wrapper around a single flaky build
# command, built for override_dh_auto_build's `bun run build` invocation
# (n0rthwood/omp-web#41).
#
# The problem: `next build --webpack` intermittently stalls dead (zero CPU,
# zero new stdout/stderr, workers idle forever) during "Collecting page
# data" — a known pre-existing flake, unrelated to source changes. Left
# alone, this burns the full CI job timeout before a human notices and
# reruns the workflow.
#
# The fix here detects OUTPUT INACTIVITY — no new stdout/stderr for
# BUILD_STALL_TIMEOUT_SECS — rather than a blunt total-wall-clock timeout.
# Successful builds are observed to legitimately take anywhere from ~14 to
# ~29+ minutes while producing output throughout, so a short total timeout
# would false-fail a slow-but-progressing build; only genuine silence is
# treated as a stall. A stalled attempt is killed (its whole process group,
# so bun/next/webpack worker processes all die, not just the direct child)
# and retried, up to BUILD_MAX_ATTEMPTS times. Each attempt also carries its
# own generous BUILD_ATTEMPT_HARD_CAP_SECS wall-clock cap, as a safety net
# for the (never observed, but not provably impossible) case of a run that
# keeps trickling output without ever finishing.
#
# Usage:
#   retry-build.sh -- <command...>
#
# Env knobs (all optional):
#   BUILD_STALL_TIMEOUT_SECS     inactivity window before an attempt is
#                                 considered stalled (default 360 = 6 min)
#   BUILD_ATTEMPT_HARD_CAP_SECS  hard wall-clock cap per attempt (default
#                                 2100 = 35 min; comfortably above the
#                                 longest observed successful build, ~29 min)
#   BUILD_MAX_ATTEMPTS           bounded retry count (default 3)
#   BUILD_POLL_INTERVAL_SECS     monitor poll interval (default 10)
#   BUILD_RETRY_CLEAN_PATHS      space-separated paths `rm -rf`'d before each
#                                 retry (not before the first attempt) —
#                                 e.g. `.next`, so a killed mid-build attempt
#                                 never leaves partial webpack/next state for
#                                 the next attempt to trip over. `next build`
#                                 has no documented safe-resume-in-place
#                                 guarantee after being killed mid-write, so
#                                 the safe default is a clean re-invoke.
set -uo pipefail
set -m  # Enable job control even though this script is non-interactive: it
        # makes every backgrounded simple command its own process group
        # leader, so `kill -TERM -$pid` below reaches the whole subtree
        # (e.g. next's spawned webpack/SWC worker processes), not just the
        # single direct child.

STALL_TIMEOUT="${BUILD_STALL_TIMEOUT_SECS:-360}"
HARD_CAP="${BUILD_ATTEMPT_HARD_CAP_SECS:-2100}"
MAX_ATTEMPTS="${BUILD_MAX_ATTEMPTS:-3}"
POLL_INTERVAL="${BUILD_POLL_INTERVAL_SECS:-10}"

if [ "${1:-}" != "--" ]; then
  echo "usage: $0 -- <command...>" >&2
  exit 2
fi
shift
if [ "$#" -eq 0 ]; then
  echo "usage: $0 -- <command...> (no command given)" >&2
  exit 2
fi

attempt=1
status=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  echo "=== retry-build.sh: attempt ${attempt}/${MAX_ATTEMPTS} (stall timeout ${STALL_TIMEOUT}s, hard cap ${HARD_CAP}s) ==="
  logfile="$(mktemp)"

  "$@" >"$logfile" 2>&1 &
  cmd_pid=$!

  # Stream the attempt's output live so CI logs still show real-time
  # progress; this file is only otherwise used for its mtime.
  tail -n +1 -f "$logfile" &
  tail_pid=$!

  start_ts=$(date +%s)
  reason=""
  while kill -0 "$cmd_pid" 2>/dev/null; do
    sleep "$POLL_INTERVAL"
    now=$(date +%s)
    elapsed=$((now - start_ts))
    last_write=$(stat -c %Y "$logfile" 2>/dev/null || echo "$start_ts")
    idle=$((now - last_write))
    if [ "$elapsed" -ge "$HARD_CAP" ]; then
      reason="exceeded hard cap ${HARD_CAP}s (elapsed ${elapsed}s)"
      break
    fi
    if [ "$idle" -ge "$STALL_TIMEOUT" ]; then
      reason="no output for ${idle}s (stall timeout ${STALL_TIMEOUT}s)"
      break
    fi
  done

  if [ -n "$reason" ]; then
    echo "=== retry-build.sh: attempt ${attempt} killed — ${reason} ===" >&2
    kill -TERM -"$cmd_pid" 2>/dev/null || kill -TERM "$cmd_pid" 2>/dev/null || true
    sleep 5
    kill -KILL -"$cmd_pid" 2>/dev/null || kill -KILL "$cmd_pid" 2>/dev/null || true
  fi

  wait "$cmd_pid"
  status=$?
  kill "$tail_pid" 2>/dev/null || true
  wait "$tail_pid" 2>/dev/null || true
  rm -f "$logfile"

  if [ "$status" -eq 0 ] && [ -z "$reason" ]; then
    echo "=== retry-build.sh: attempt ${attempt} succeeded ==="
    exit 0
  fi

  echo "=== retry-build.sh: attempt ${attempt} failed (exit ${status}${reason:+, ${reason}}) ==="
  if [ "$attempt" -lt "$MAX_ATTEMPTS" ] && [ -n "${BUILD_RETRY_CLEAN_PATHS:-}" ]; then
    echo "=== retry-build.sh: clearing partial build state before retry: ${BUILD_RETRY_CLEAN_PATHS} ==="
    # shellcheck disable=SC2086 # intentionally word-split, a path list
    rm -rf ${BUILD_RETRY_CLEAN_PATHS}
  fi
  attempt=$((attempt + 1))
done

echo "=== retry-build.sh: all ${MAX_ATTEMPTS} attempts failed, giving up ===" >&2
exit "$status"
