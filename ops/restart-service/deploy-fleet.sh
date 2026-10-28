#!/usr/bin/env bash
# Idempotent fleet installer for omp-web-restart-service (issue #85).
#
# Run FROM the gateway repo checkout:
#
#   ops/restart-service/deploy-fleet.sh              # all remote hosts
#   ops/restart-service/deploy-fleet.sh --gateway    # this machine only
#   ops/restart-service/deploy-fleet.sh --all        # gateway + remotes
#   HOSTS="172.30.3.24 172.30.3.39" deploy-fleet.sh  # override host list
#
# Per remote host (user joysort everywhere; the unit hardcodes
# /home/joysort paths, so the same unit works fleet-wide):
#   1. mkdir -p ~/omp/ops/env ~/omp/ops/logs/restart-service
#      ~/omp/ompweb/ops/restart-service ~/.config/systemd/user
#   2. if ~/omp/ops/env/restart-service.env does not exist, mint a token
#      LOCALLY (openssl rand -hex 24) and scp it over, mode 600. Existing
#      env files are never touched and tokens are never printed — an
#      idempotent re-run must not rotate credentials.
#   3. scp server.py, restart-payload.sh and the unit into
#      ~/omp/ompweb/ops/restart-service/.
#   4. install the unit, daemon-reload, enable + restart it.
#   5. verify: unit active AND 127.0.0.1:8799/health == "ok".
#
# --gateway normalizes THIS machine in place instead: the payload and
# server.py already live in the checkout, so it only drops the legacy
# RESTART_SERVICE_SCRIPT line from the env file (so the new default — the
# payload shipped next to server.py — applies), keeps the existing token /
# PORT / LOG_DIR lines, reinstalls the unit, restarts the daemon, and
# health-checks. Refuses to run if the gateway env file is missing rather
# than minting a second token.
set -uo pipefail

# Loopback traffic must bypass any proxy in the environment.
export NO_PROXY='*' no_proxy='*'
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy

SRC_DIR=$(cd "$(dirname "$0")" && pwd)
GW_ENV_FILE="$HOME/omp/ops/env/restart-service.env"
GW_UNIT_DIR="$HOME/.config/systemd/user"
DEFAULT_HOSTS="172.30.3.250 172.30.3.24 172.30.3.109 172.30.3.202 172.30.3.39 172.30.3.110"
HOSTS="${HOSTS:-$DEFAULT_HOSTS}"

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)
SCP_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -p)

MODE=remotes
for arg in "$@"; do
  case "$arg" in
    --gateway) MODE=gateway ;;
    --all) MODE=all ;;
    *)
      echo "usage: $0 [--gateway|--all]   (default: remote hosts only; HOSTS env var overrides the list)" >&2
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

results=()
fail=0

record() { results+=("$(printf '%-16s %s' "$1" "$2")"); }

mint_env_file() { # $1 = destination; writes token without echoing it
  umask 077
  {
    echo "RESTART_SERVICE_TOKEN=$(openssl rand -hex 24)"
    echo "RESTART_SERVICE_PORT=8799"
    echo "RESTART_SERVICE_LOG_DIR=$HOME/omp/ops/logs/restart-service"
  } > "$1"
}

deploy_remote() {
  local host="$1" envfile out

  if ! out=$(ssh "${SSH_OPTS[@]}" "$host" \
      'mkdir -p ~/omp/ops/env ~/omp/ops/logs/restart-service ~/omp/ompweb/ops/restart-service ~/.config/systemd/user' 2>&1); then
    record "$host" "FAIL: unreachable/mkdir ($out)"
    return 1
  fi

  if ! ssh "${SSH_OPTS[@]}" "$host" 'test -f ~/omp/ops/env/restart-service.env'; then
    envfile=$(mktemp /tmp/restart-service.env.XXXXXX) || { record "$host" "FAIL: mktemp"; return 1; }
    mint_env_file "$envfile"
    if ! scp "${SCP_OPTS[@]}" "$envfile" "$host:omp/ops/env/restart-service.env"; then
      rm -f "$envfile"
      record "$host" "FAIL: scp env file"
      return 1
    fi
    rm -f "$envfile"
  fi

  if ! scp "${SCP_OPTS[@]}" \
      "$SRC_DIR/server.py" "$SRC_DIR/restart-payload.sh" \
      "$SRC_DIR/omp-web-restart-service.service" \
      "$host:omp/ompweb/ops/restart-service/"; then
    record "$host" "FAIL: scp service files"
    return 1
  fi

  if ! out=$(ssh "${SSH_OPTS[@]}" "$host" '
      set -e
      cp ~/omp/ompweb/ops/restart-service/omp-web-restart-service.service ~/.config/systemd/user/
      systemctl --user daemon-reload
      systemctl --user enable omp-web-restart-service
      systemctl --user restart omp-web-restart-service
    ' 2>&1); then
    record "$host" "FAIL: unit install/enable ($out)"
    return 1
  fi

  if ! out=$(ssh "${SSH_OPTS[@]}" "$host" '
      active=$(systemctl --user is-active omp-web-restart-service)
      health=$(curl -s --noproxy "*" http://127.0.0.1:8799/health)
      echo "active=$active health=$health"
      [ "$active" = "active" ] && [ "$health" = "ok" ]
    ' 2>&1); then
    record "$host" "FAIL: verify ($out)"
    return 1
  fi
  record "$host" "OK ($out)"
  return 0
}

deploy_gateway() {
  local tmp active health

  if [ ! -f "$GW_ENV_FILE" ]; then
    echo "gateway env file missing: $GW_ENV_FILE — refusing to mint a fresh token; create it by hand first" >&2
    record gateway "FAIL: env file missing"
    return 1
  fi

  mkdir -p "$GW_UNIT_DIR" "$HOME/omp/ops/logs/restart-service"

  # Normalize in place: keep token/PORT/LOG_DIR, drop the legacy
  # RESTART_SERVICE_SCRIPT line so the in-repo default payload applies.
  tmp=$(mktemp /tmp/restart-service.env.XXXXXX) || { record gateway "FAIL: mktemp"; return 1; }
  grep -v '^RESTART_SERVICE_SCRIPT=' "$GW_ENV_FILE" > "$tmp" || true
  if ! cmp -s "$tmp" "$GW_ENV_FILE"; then
    cat "$tmp" > "$GW_ENV_FILE"   # rewrite contents; keeps inode + mode 600
  fi
  rm -f "$tmp"

  cp "$SRC_DIR/omp-web-restart-service.service" "$GW_UNIT_DIR/"
  systemctl --user daemon-reload
  systemctl --user restart omp-web-restart-service

  active=$(systemctl --user is-active omp-web-restart-service)
  health=$(curl -s --noproxy '*' http://127.0.0.1:8799/health)
  if [ "$active" = "active" ] && [ "$health" = "ok" ]; then
    record gateway "OK (active, health ok, in-repo payload default)"
    return 0
  fi
  record gateway "FAIL: active=$active health=$health"
  return 1
}

case "$MODE" in
  gateway)
    deploy_gateway || fail=1
    ;;
  remotes)
    for host in $HOSTS; do
      deploy_remote "$host" || fail=1
    done
    ;;
  all)
    deploy_gateway || fail=1
    for host in $HOSTS; do
      deploy_remote "$host" || fail=1
    done
    ;;
esac

echo
echo "---- deploy summary ----"
printf '%s\n' "${results[@]}"
exit "$fail"
