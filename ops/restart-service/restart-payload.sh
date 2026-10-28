#!/usr/bin/env bash
# omp-web-restart-service payload: upgrade or restart this host's omp-web.
#
# Invoked by server.py as `bash restart-payload.sh <mode>` with stdout+stderr
# captured into the daemon's run log. Modes:
#   upgrade (default) — apt upgrade omp-web (postinst restarts
#       omp-web.service on :5010), then on gateway-shaped hosts (a second
#       omp-web-dev.service unit sharing the same repo-root .next) wait for
#       :5010 to come back before restarting the dev unit. Remotes have no
#       dev unit and skip that step.
#   restart — systemctl --user restart omp-web.service only, no apt.
set -euo pipefail

MODE="${1:-upgrade}"

log() { echo "[$(date -Is)] $*"; }

# Loopback traffic must bypass any proxy in the environment.
export NO_PROXY='*' no_proxy='*'
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy

# The daemon runs as a systemd --user unit and inherits XDG_RUNTIME_DIR;
# be defensive in case this payload is ever driven by hand.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

case "$MODE" in
  upgrade)
    export DEBIAN_FRONTEND=noninteractive
    log "mode=upgrade: apt-get update"
    sudo apt-get update
    log "mode=upgrade: apt-get install --only-upgrade omp-web"
    sudo apt-get install --only-upgrade -y omp-web

    # Gateway only: nothing else restarts omp-web-dev.service, and both
    # units share one .next — leaving it stale is what produced the
    # 2026-09-06 React Client Manifest 500s on :5020.
    if systemctl --user list-unit-files omp-web-dev.service 2>/dev/null \
       | grep -q omp-web-dev.service; then
      log "dev unit present: polling http://127.0.0.1:5010/api/health"
      # Any HTTP answer (even 401 — :5010 is authenticated) means the
      # server is back up; curl prints 000 only on connection failure.
      healthy=""
      for _ in $(seq 1 120); do
        code=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' \
               http://127.0.0.1:5010/api/health || true)
        if [ "$code" != "000" ]; then
          healthy=1
          break
        fi
        sleep 1
      done
      if [ -n "$healthy" ]; then
        log ":5010 answering after upgrade (http=$code)"
      else
        log "WARNING: :5010 not answering within ~120s; restarting dev unit anyway"
      fi
      systemctl --user restart omp-web-dev.service
      log "omp-web-dev.service restarted: $(systemctl --user is-active omp-web-dev.service)"
    else
      log "no omp-web-dev.service unit file; dev restart skipped"
    fi
    log "mode=upgrade: done"
    ;;
  restart)
    log "mode=restart: systemctl --user restart omp-web.service"
    systemctl --user restart omp-web.service
    log "omp-web.service: $(systemctl --user is-active omp-web.service)"
    log "mode=restart: done"
    ;;
  *)
    echo "[$(date -Is)] unknown mode: '$MODE' (expected upgrade|restart)" >&2
    exit 2
    ;;
esac
