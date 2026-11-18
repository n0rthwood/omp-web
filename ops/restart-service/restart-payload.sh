#!/usr/bin/env bash
# omp-web-restart-service payload: upgrade or restart this host's omp-web.
#
# Invoked by server.py as `bash restart-payload.sh <mode>` with stdout+stderr
# captured into the daemon's run log. Modes:
#   upgrade (default) — apt upgrade omp-web (postinst restarts
#       omp-web.service on :5010).
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
