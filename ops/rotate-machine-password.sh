#!/usr/bin/env bash
set -euo pipefail
# Rotate one fleet remote's OMP_WEB_PASSWORD, end to end, from the gateway.
#
# Since omp-web 0.5.5 every host generates its own OMP_WEB_PASSWORD at
# install time (`debian/postinst`'s `seed_env_file`), so the credential is a
# per-machine secret with no shared value to fall back on. Rotating one host
# therefore takes FOUR writes that must all land, in this order:
#
#   1. remote   $HOME/omp/ops/env/5010.env   OMP_WEB_PASSWORD=<new>   (0600)
#   2. remote   systemctl --user restart omp-web.service
#   3. gateway  ~/omp/ops/env/fleet/<IP>.env OMP_WEB_PASSWORD=<new>   (0600)
#   4. gateway  PATCH /api/machines/<id>     {"token": "<new>"}
#
# Steps 1+2 change what the remote accepts; steps 3+4 change what the gateway
# sends. Stopping between 2 and 4 leaves the gateway holding a dead
# credential: the remote answers 401, `lib/machines/remote-request.ts` treats
# any HTTP response as final (no retry, no fallback endpoint, no degraded
# mode), and the UI shows "<name> is unauthorized". This script therefore
# aborts at the first failure and prints exactly how far it got, so the
# operator knows whether the fleet is currently consistent.
#
# Secret handling: the new password is generated into a 0600 file inside a
# 0700 temp dir, handed to ssh on stdin and to curl through a --config file.
# It never appears in argv (`ps` is world-readable), never in an environment
# variable, and is never printed — not even in --dry-run.

GATEWAY_URL="http://127.0.0.1:5010"
GATEWAY_ENV="$HOME/omp/ops/env/5010.env"
FLEET_ENV_DIR="$HOME/omp/ops/env/fleet"
ADMIN_CRED_FILE=""
SSH_TARGET=""
REMOTE_ENV=""
FLEET_ENV=""
SSH_TIMEOUT=15
HEALTH_TIMEOUT=60
DRY_RUN=0
ASSUME_YES=0

usage() {
  cat <<'EOF'
Usage: rotate-machine-password.sh [options] TARGET

Rotate the OMP_WEB_PASSWORD of one registered fleet remote and re-point the
gateway at it, in the four mandatory steps. Run this ON THE GATEWAY
(172.30.3.123) as the user that owns ~/omp/ops/env.

TARGET  A registered machine id, its name, or the host/IP in its baseUrl.
        Resolved against GET /api/machines; the resolution must be unique.
        The local machine cannot be rotated (PATCH /api/machines/local = 400).

Options:
  --dry-run              Resolve, probe and validate everything, print the
                         plan, change nothing. No password is generated.
  -y, --yes              Skip the interactive confirmation.
  --gateway-url URL      Gateway origin (default http://127.0.0.1:5010).
  --gateway-env PATH     Gateway env file holding the admin credential
                         (default ~/omp/ops/env/5010.env). OMP_WEB_USERNAME
                         defaults to "omp" when the file omits it.
  --admin-cred-file PATH Use this file instead: one line, "username:password".
  --ssh DEST             ssh destination for the remote (default: the host
                         from the machine's baseUrl).
  --remote-env PATH      Remote env file (default <remote $HOME>/omp/ops/env/5010.env;
                         $HOME is resolved over ssh because it is
                         /var/lib/jsfb/home on machines, /home/joysort on the gateway).
  --fleet-env PATH       Gateway mirror file (default ~/omp/ops/env/fleet/<baseUrl host>.env).
                         Required when the default does not exist: the mirror
                         files are keyed by the PHYSICAL 10.10.170.x address
                         while baseUrl usually carries the ZeroTier address.
                         A non-existent path is created, mode 0600.
  --ssh-timeout SECONDS  ssh ConnectTimeout (default 15).
  --health-timeout SECS  How long to wait for the restarted remote to answer
                         200 with the new credential (default 60).
  -h, --help             This text.

Examples:
  # See what would happen, change nothing:
  ops/rotate-machine-password.sh --dry-run joysort24

  # Rotate, mirror keyed by the physical LAN address:
  ops/rotate-machine-password.sh --fleet-env ~/omp/ops/env/fleet/10.10.170.206.env joysort24

  # Non-interactive:
  ops/rotate-machine-password.sh -y --fleet-env ~/omp/ops/env/fleet/10.10.170.223.env 172.30.3.39

Exit codes: 0 success; 1 usage/precondition failure (nothing changed);
2 a rotation step failed (read the printed "completed through step N").
EOF
}

say()  { printf 'rotate: %s\n' "$*" >&2; }
die()  { printf 'rotate: %s\n' "$*" >&2; exit 1; }

# --- argument parsing ---------------------------------------------------------

TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    --gateway-url) GATEWAY_URL="${2:?--gateway-url needs a value}"; shift ;;
    --gateway-env) GATEWAY_ENV="${2:?--gateway-env needs a value}"; shift ;;
    --admin-cred-file) ADMIN_CRED_FILE="${2:?--admin-cred-file needs a value}"; shift ;;
    --ssh) SSH_TARGET="${2:?--ssh needs a value}"; shift ;;
    --remote-env) REMOTE_ENV="${2:?--remote-env needs a value}"; shift ;;
    --fleet-env) FLEET_ENV="${2:?--fleet-env needs a value}"; shift ;;
    --ssh-timeout) SSH_TIMEOUT="${2:?--ssh-timeout needs a value}"; shift ;;
    --health-timeout) HEALTH_TIMEOUT="${2:?--health-timeout needs a value}"; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) usage >&2; die "unknown option: $1" ;;
    *)
      [ -z "$TARGET" ] || { usage >&2; die "more than one TARGET given: $TARGET, $1"; }
      TARGET="$1"
      ;;
  esac
  shift
done
[ -n "$TARGET" ] || { usage >&2; exit 1; }
GATEWAY_URL="${GATEWAY_URL%/}"

for tool in curl ssh python3 base64 mktemp; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool not found: $tool"
done

# --- scratch space ------------------------------------------------------------

umask 077
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/omp-web-rotate.XXXXXX")"
# Once the remote service has been restarted onto the new password, the
# gateway is 401 against it until step 4 lands. Keep the scratch copy in that
# window so the operator can finish by hand; everywhere else wipe it.
KEEP_WORKDIR=0
cleanup() {
  if [ "$KEEP_WORKDIR" = 1 ]; then
    say "new password left in $WORKDIR/new.pw (0600) — use it to finish, then: rm -rf $WORKDIR"
    return
  fi
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

STEPS_DONE=0
# Set the instant `systemctl restart` returns 0 — the remote is then serving
# the new password whether or not the health probe that follows succeeds.
RESTART_ISSUED=0
STEP_LABELS=(
  "1/4 remote 5010.env rewritten"
  "2/4 remote omp-web.service restarted and answering with the new password"
  "3/4 gateway fleet mirror updated"
  "4/4 gateway machine credential patched"
)
mark_step() {
  STEPS_DONE="$1"
  say "ok  ${STEP_LABELS[$(($1 - 1))]}"
}
fail_step() {
  # $1 = failing step number, $2… = message
  local n="$1"; shift
  printf 'rotate: FAILED at step %s/4: %s\n' "$n" "$*" >&2
  if [ "$STEPS_DONE" -eq 0 ]; then
    printf 'rotate: completed through step 0/4 — nothing was changed.\n' >&2
  else
    printf 'rotate: completed through step %s/4 (%s).\n' \
      "$STEPS_DONE" "${STEP_LABELS[$((STEPS_DONE - 1))]}" >&2
  fi
  if [ "$RESTART_ISSUED" = 1 ] && [ "$STEPS_DONE" -lt 4 ]; then
    KEEP_WORKDIR=1
    printf 'rotate: THE GATEWAY IS NOW 401 AGAINST %s — the remote restarted onto the new\n' "$MACHINE_ID" >&2
    printf 'rotate: password and the gateway still holds the old one. Finish by hand, now:\n' >&2
    [ "$STEPS_DONE" -ge 2 ] \
      || printf 'rotate:   step 2  ssh %s: systemctl --user restart omp-web.service, then confirm\nrotate:           %s/api/health answers 200 as %s\n' \
           "$SSH_TARGET" "$MACHINE_BASE_URL" "$REMOTE_USERNAME" >&2
    [ "$STEPS_DONE" -ge 3 ] \
      || printf 'rotate:   step 3  write OMP_WEB_PASSWORD=<new> into %s (mode 0600)\n' "$FLEET_ENV" >&2
    printf 'rotate:   step 4  PATCH %s/api/machines/%s with {"token": "<new>"}\n' "$GATEWAY_URL" "$MACHINE_ID" >&2
  elif [ "$STEPS_DONE" -ge 1 ]; then
    printf 'rotate: the remote process still serves the OLD password from memory (no restart was\n' >&2
    printf 'rotate: issued), so the gateway keeps working. Re-running this script is safe: it\n' >&2
    printf 'rotate: generates a fresh password and redoes all four steps.\n' >&2
  fi
  exit 2
}

# --- helpers ------------------------------------------------------------------

# Read one KEY=value from an env file, stripping the legacy surrounding
# quotes (values seeded before 0.5.5 came from the sealed store quoted).
# Prints the value on stdout; exit 3 when the key is absent.
read_env_value() {
  python3 - "$1" "$2" <<'PY'
import sys
path, key = sys.argv[1], sys.argv[2]
value = None
try:
    with open(path, encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if line.startswith(key + "="):
                value = line[len(key) + 1:]
except OSError as error:
    sys.stderr.write(f"cannot read {path}: {error}\n")
    raise SystemExit(4)
if value is None:
    raise SystemExit(3)
if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
    value = value[1:-1]
sys.stdout.write(value)
PY
}

# Write a curl --config file carrying HTTP Basic credentials. Never logged.
# curl's quoted form needs \ and " escaped; everything else is literal.
write_curl_config() {
  local out="$1" user="$2" password="$3" escaped
  escaped="$(printf '%s' "$user:$password" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
  printf 'user = "%s"\n' "$escaped" > "$out"
  chmod 0600 "$out"
}

# Run a bash snippet on the remote with the caller's stdin intact.
# The snippet travels base64-encoded in argv (it holds no secrets); stdin
# stays free so the password can be piped in. Extra args become $1, $2, …
remote_exec() {
  local script="$1"; shift
  local encoded quoted_args=""
  encoded="$(printf '%s' "$script" | base64 | tr -d '\n')"
  if [ $# -gt 0 ]; then
    quoted_args="$(printf '%q ' "$@")"
  fi
  # No `exec`: a plain command with a leading assignment is unambiguously
  # exported to that command in every POSIX shell.
  ssh -o BatchMode=yes -o "ConnectTimeout=$SSH_TIMEOUT" "$SSH_TARGET" \
    "OMPW_SCRIPT_B64=$encoded /bin/bash -c 'eval \"\$(printf %s \"\$OMPW_SCRIPT_B64\" | base64 -d)\"' omp-web-rotate $quoted_args"
}

# --- gateway admin credential -------------------------------------------------

if [ -n "$ADMIN_CRED_FILE" ]; then
  [ -f "$ADMIN_CRED_FILE" ] || die "--admin-cred-file not found: $ADMIN_CRED_FILE"
  ADMIN_LINE="$(head -n 1 "$ADMIN_CRED_FILE")"
  case "$ADMIN_LINE" in
    *:*) ;;
    *) die "--admin-cred-file must hold one \"username:password\" line" ;;
  esac
  ADMIN_USER="${ADMIN_LINE%%:*}"
  ADMIN_PASS="${ADMIN_LINE#*:}"
else
  [ -f "$GATEWAY_ENV" ] || die "gateway env file not found: $GATEWAY_ENV (pass --gateway-env or --admin-cred-file)"
  ADMIN_USER="$(read_env_value "$GATEWAY_ENV" OMP_WEB_USERNAME || true)"
  [ -n "$ADMIN_USER" ] || ADMIN_USER="omp"
  set +e
  ADMIN_PASS="$(read_env_value "$GATEWAY_ENV" OMP_WEB_PASSWORD)"
  read_status=$?
  set -e
  [ "$read_status" -eq 0 ] || die "no OMP_WEB_PASSWORD in $GATEWAY_ENV — pass --admin-cred-file with an admin account"
fi
[ -n "$ADMIN_PASS" ] || die "the gateway admin password resolved to an empty value"
write_curl_config "$WORKDIR/gateway.curl" "$ADMIN_USER" "$ADMIN_PASS"
unset ADMIN_PASS ADMIN_LINE

# --- resolve the machine ------------------------------------------------------

gateway_get() {
  # $1 = path, $2 = output file. Prints the HTTP status on stdout.
  curl --config "$WORKDIR/gateway.curl" -sS --max-time 30 \
    -o "$2" -w '%{http_code}' "$GATEWAY_URL$1"
}

status="$(gateway_get /api/machines "$WORKDIR/machines.json")" \
  || die "cannot reach the gateway at $GATEWAY_URL — run this on the gateway, or pass --gateway-url"
case "$status" in
  200) ;;
  401) die "gateway rejected the admin credential (401) — check $GATEWAY_ENV or pass --admin-cred-file" ;;
  403) die "gateway returned 403 — the credential is not an admin, or the Host is not allow-listed" ;;
  *) die "GET /api/machines returned HTTP $status" ;;
esac

MACHINE_JSON="$WORKDIR/machine.json"
if ! python3 - "$WORKDIR/machines.json" "$TARGET" "$MACHINE_JSON" <<'PY'
import json, sys
from urllib.parse import urlparse

source, target, out = sys.argv[1], sys.argv[2], sys.argv[3]
machines = json.load(open(source, encoding="utf-8")).get("machines", [])
remote = [m for m in machines if not m.get("isLocal")]

def host_of(machine):
    try:
        return urlparse(machine.get("baseUrl", "")).hostname or ""
    except ValueError:
        return ""

exact = [m for m in remote if m.get("id") == target]
matches = exact or [
    m for m in remote
    if m.get("name") == target or host_of(m) == target
]
if not matches:
    local_hit = [m for m in machines if m.get("isLocal") and (m.get("id") == target or m.get("name") == target)]
    if local_hit:
        sys.stderr.write("the local machine cannot be rotated — it has no stored credential and PATCH /api/machines/local returns 400\n")
        raise SystemExit(2)
    sys.stderr.write(
        "no registered machine matches %r. Known: %s\n"
        % (target, ", ".join("%s (%s)" % (m.get("id"), host_of(m)) for m in remote) or "<none>")
    )
    raise SystemExit(3)
if len(matches) > 1:
    sys.stderr.write(
        "%r is ambiguous: %s — pass the machine id\n"
        % (target, ", ".join(m.get("id", "?") for m in matches))
    )
    raise SystemExit(4)
json.dump(matches[0], open(out, "w", encoding="utf-8"))
PY
then
  die "could not resolve TARGET"
fi

machine_field() {
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$MACHINE_JSON" "$1"
}
MACHINE_ID="$(machine_field id)"
MACHINE_NAME="$(machine_field name)"
MACHINE_BASE_URL="$(machine_field baseUrl)"
MACHINE_AUTH_MODE="$(machine_field authMode)"
MACHINE_HOST="$(python3 -c 'import json,sys;from urllib.parse import urlparse;print(urlparse(json.load(open(sys.argv[1]))["baseUrl"]).hostname or "")' "$MACHINE_JSON")"

[ "$MACHINE_AUTH_MODE" = "basic" ] \
  || die "machine $MACHINE_ID uses authMode=$MACHINE_AUTH_MODE; this script rotates the Basic OMP_WEB_PASSWORD only"
[ -n "$MACHINE_HOST" ] || die "machine $MACHINE_ID has an unparseable baseUrl: $MACHINE_BASE_URL"

[ -n "$SSH_TARGET" ] || SSH_TARGET="$MACHINE_HOST"

# --- remote preflight ---------------------------------------------------------

REMOTE_FACTS="$WORKDIR/remote-facts"
if ! remote_exec 'printf "%s\n%s\n%s\n" "$(hostname)" "$HOME" "$(id -u)"' > "$REMOTE_FACTS" 2>"$WORKDIR/ssh.err"; then
  sed 's/^/rotate:   ssh: /' "$WORKDIR/ssh.err" >&2 || true
  die "ssh $SSH_TARGET failed — fix connectivity first (nothing was changed)"
fi
REMOTE_HOSTNAME="$(sed -n 1p "$REMOTE_FACTS")"
REMOTE_HOME="$(sed -n 2p "$REMOTE_FACTS")"
REMOTE_UID="$(sed -n 3p "$REMOTE_FACTS")"
[ -n "$REMOTE_HOSTNAME" ] && [ -n "$REMOTE_HOME" ] || die "could not read hostname/HOME from $SSH_TARGET"

# $HOME is /var/lib/jsfb/home on a sorting machine and /home/joysort on the
# gateway, so it is resolved over ssh rather than assumed.
[ -n "$REMOTE_ENV" ] || REMOTE_ENV="$REMOTE_HOME/omp/ops/env/5010.env"

# Confirm the env file is rotatable and learn which username the remote's
# Basic identity uses — `toSafeMachine` deliberately never exposes the stored
# username, so the remote's own OMP_WEB_USERNAME is the authority.
if ! remote_exec '
set -euo pipefail
env_file="$1"
[ -f "$env_file" ] || { echo "no such file: $env_file" >&2; exit 2; }
grep -q "^OMP_WEB_PASSWORD=." "$env_file" || { echo "no non-empty OMP_WEB_PASSWORD= line in $env_file" >&2; exit 3; }
user="$(sed -n "s/^OMP_WEB_USERNAME=//p" "$env_file" | tail -n 1)"
user="${user%\"}"
user="${user#\"}"
printf "%s\n" "${user:-omp}"
' "$REMOTE_ENV" > "$WORKDIR/remote-user" 2>"$WORKDIR/remote-precheck.err"; then
  sed 's/^/rotate:   remote: /' "$WORKDIR/remote-precheck.err" >&2 || true
  die "remote env file precheck failed on $SSH_TARGET (nothing was changed)"
fi
REMOTE_USERNAME="$(sed -n 1p "$WORKDIR/remote-user")"
[ -n "$REMOTE_USERNAME" ] || REMOTE_USERNAME="omp"

# --- gateway mirror path ------------------------------------------------------

if [ -z "$FLEET_ENV" ]; then
  FLEET_ENV="$FLEET_ENV_DIR/$MACHINE_HOST.env"
  if [ ! -f "$FLEET_ENV" ]; then
    say "no mirror file at $FLEET_ENV"
    say "the mirror files are keyed by the host's PHYSICAL address, not the ZeroTier one in baseUrl."
    if [ -d "$FLEET_ENV_DIR" ]; then
      say "existing mirrors in $FLEET_ENV_DIR:"
      ls -1 "$FLEET_ENV_DIR" | sed 's/^/rotate:   /' >&2 || true
    fi
    die "pass --fleet-env with the right path (it may not exist yet; it will be created 0600)"
  fi
fi
FLEET_ENV_PARENT="$(dirname "$FLEET_ENV")"
[ -d "$FLEET_ENV_PARENT" ] || die "mirror directory does not exist: $FLEET_ENV_PARENT"
[ -w "$FLEET_ENV_PARENT" ] || die "mirror directory is not writable: $FLEET_ENV_PARENT"

# --- plan ---------------------------------------------------------------------

cat >&2 <<EOF
rotate: plan
rotate:   machine         $MACHINE_ID ($MACHINE_NAME), authMode=$MACHINE_AUTH_MODE
rotate:   baseUrl         $MACHINE_BASE_URL
rotate:   ssh             $SSH_TARGET -> hostname=$REMOTE_HOSTNAME HOME=$REMOTE_HOME uid=$REMOTE_UID
rotate:   step 1  remote  rewrite OMP_WEB_PASSWORD in $REMOTE_ENV (0600, atomic)
rotate:   step 2  remote  systemctl --user restart omp-web.service
rotate:   step 3  gateway rewrite OMP_WEB_PASSWORD in $FLEET_ENV (0600, atomic)
rotate:   step 4  gateway PATCH $GATEWAY_URL/api/machines/$MACHINE_ID {"token": …}
rotate:   verify          GET $GATEWAY_URL/api/machines/$MACHINE_ID/api/health == 200, hostname == $REMOTE_HOSTNAME
rotate: the step-2 restart kills every live AgentSession, terminal and running
rotate: agent turn on $REMOTE_HOSTNAME, and the gateway is 401 against it until step 4 lands.
EOF

if [ "$DRY_RUN" = 1 ]; then
  say "--dry-run: no password generated, nothing written, no service restarted."
  exit 0
fi

if [ "$ASSUME_YES" != 1 ]; then
  if [ ! -t 0 ]; then
    die "refusing to rotate non-interactively without --yes"
  fi
  printf 'rotate: rotate %s (%s) now? [y/N] ' "$MACHINE_ID" "$REMOTE_HOSTNAME" >&2
  IFS= read -r answer || answer=""
  case "$answer" in
    y|Y|yes|YES) ;;
    *) die "aborted by operator (nothing was changed)" ;;
  esac
fi

# --- the new password ---------------------------------------------------------

NEW_PW_FILE="$WORKDIR/new.pw"
python3 -c 'import secrets;print(secrets.token_urlsafe(32))' > "$NEW_PW_FILE"
chmod 0600 "$NEW_PW_FILE"
# token_urlsafe is [A-Za-z0-9_-] only: safe unquoted in an EnvironmentFile,
# in a curl config value and in JSON. The newline is the delimiter the remote
# `read` consumes; it is never part of the value.
[ -s "$NEW_PW_FILE" ] || die "password generation produced nothing"

# --- step 1: remote env file --------------------------------------------------

if ! remote_exec '
set -euo pipefail
env_file="$1"
IFS= read -r new_password || true
[ -n "$new_password" ] || { echo "empty password on stdin"; exit 4; }
[ -f "$env_file" ] || { echo "no such file: $env_file"; exit 2; }
grep -q "^OMP_WEB_PASSWORD=" "$env_file" || { echo "no OMP_WEB_PASSWORD= line in $env_file"; exit 3; }
umask 077
tmp="$(mktemp "$(dirname "$env_file")/.5010.env.rotate.XXXXXX")"
trap "rm -f \"$tmp\"" EXIT
# Same-directory mktemp + mv: a kill mid-write can only leave a stray temp
# file, never a truncated 5010.env that would start omp-web without auth.
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    OMP_WEB_PASSWORD=*) printf "%s\n" "OMP_WEB_PASSWORD=$new_password" ;;
    *) printf "%s\n" "$line" ;;
  esac
done < "$env_file" > "$tmp"
grep -q "^OMP_WEB_PASSWORD=." "$tmp" || { echo "rewrite produced no password line"; exit 5; }
chmod 0600 "$tmp"
mv -f "$tmp" "$env_file"
trap - EXIT
' "$REMOTE_ENV" < "$NEW_PW_FILE" > "$WORKDIR/step1.log" 2>&1; then
  sed 's/^/rotate:   remote: /' "$WORKDIR/step1.log" >&2 || true
  fail_step 1 "could not rewrite $REMOTE_ENV on $SSH_TARGET"
fi
mark_step 1

# --- step 2: restart the remote service ---------------------------------------

# Conservative by design: a `systemctl restart` that exits non-zero can still
# have stopped and restarted the unit, so assume the remote has already moved
# to the new password from the moment the command is issued.
RESTART_ISSUED=1
if ! remote_exec '
set -euo pipefail
: "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"
export XDG_RUNTIME_DIR
systemctl --user restart omp-web.service
systemctl --user is-active --quiet omp-web.service
' > "$WORKDIR/step2.log" 2>&1; then
  sed 's/^/rotate:   remote: /' "$WORKDIR/step2.log" >&2 || true
  fail_step 2 "systemctl --user restart omp-web.service failed on $SSH_TARGET (the env file already holds the new password)"
fi

# The restart only counts once the remote accepts the NEW credential on a
# direct probe — taken before the gateway is touched, so the remote half and
# the gateway half stay independently diagnosable.
write_curl_config "$WORKDIR/remote.curl" "$REMOTE_USERNAME" "$(cat "$NEW_PW_FILE")"
probe_status=""
deadline=$((SECONDS + HEALTH_TIMEOUT))
while [ "$SECONDS" -lt "$deadline" ]; do
  # curl prints `000` for %{http_code} when it never got a response, so `|| true`
  # (not `|| echo 000`, which would concatenate onto curl's own output).
  probe_status="$(curl --config "$WORKDIR/remote.curl" -sS --max-time 10 \
    -o "$WORKDIR/remote-health.json" -w '%{http_code}' "$MACHINE_BASE_URL/api/health" 2>/dev/null || true)"
  [ "$probe_status" = "200" ] && break
  sleep 2
done
if [ "$probe_status" != "200" ]; then
  fail_step 2 "$MACHINE_BASE_URL/api/health did not return 200 as $REMOTE_USERNAME within ${HEALTH_TIMEOUT}s (last status: ${probe_status:-none})"
fi
mark_step 2

# --- step 3: gateway mirror ---------------------------------------------------

if ! python3 - "$FLEET_ENV" "$NEW_PW_FILE" <<'PY'
import os, sys, tempfile
target, pw_file = sys.argv[1], sys.argv[2]
password = open(pw_file, encoding="utf-8").read().strip()
if not password:
    raise SystemExit("empty password file")
lines, replaced = [], False
if os.path.exists(target):
    with open(target, encoding="utf-8") as handle:
        for raw in handle:
            if raw.strip().startswith("OMP_WEB_PASSWORD="):
                lines.append("OMP_WEB_PASSWORD=" + password)
                replaced = True
            else:
                lines.append(raw.rstrip("\n"))
if not replaced:
    lines.append("OMP_WEB_PASSWORD=" + password)
directory = os.path.dirname(os.path.abspath(target)) or "."
handle_fd, tmp = tempfile.mkstemp(prefix=".rotate.", dir=directory)
try:
    with os.fdopen(handle_fd, "w", encoding="utf-8") as out:
        out.write("\n".join(lines) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, target)
except BaseException:
    os.unlink(tmp)
    raise
PY
then
  fail_step 3 "could not update the gateway mirror $FLEET_ENV"
fi
mark_step 3

# --- step 4: gateway machine credential ---------------------------------------

python3 -c 'import json,sys;sys.stdout.write(json.dumps({"token": open(sys.argv[1], encoding="utf-8").read().strip()}))' \
  "$NEW_PW_FILE" > "$WORKDIR/patch.json"
chmod 0600 "$WORKDIR/patch.json"

patch_status="$(curl --config "$WORKDIR/gateway.curl" -sS --max-time 30 \
  -X PATCH -H 'Content-Type: application/json' \
  --data-binary "@$WORKDIR/patch.json" \
  -o "$WORKDIR/patch-response.json" -w '%{http_code}' \
  "$GATEWAY_URL/api/machines/$MACHINE_ID" 2>/dev/null || true)"
case "$patch_status" in
  200) ;;
  400) fail_step 4 "gateway rejected the patch (400): $(cat "$WORKDIR/patch-response.json")" ;;
  403) fail_step 4 "gateway returned 403 — admin credential or fleet-configuration gate" ;;
  404) fail_step 4 "gateway does not know machine $MACHINE_ID (404)" ;;
  *) fail_step 4 "PATCH /api/machines/$MACHINE_ID returned HTTP ${patch_status:-none}" ;;
esac
# The response never echoes the token; hasCredential is the only signal.
python3 -c '
import json, sys
body = json.load(open(sys.argv[1], encoding="utf-8"))
if not body.get("hasCredential"):
    sys.exit("machine updated but hasCredential is false")
' "$WORKDIR/patch-response.json" || fail_step 4 "the patched machine reports no stored credential"
mark_step 4

# --- verify end to end --------------------------------------------------------

verify_status="$(gateway_get "/api/machines/$MACHINE_ID/api/health" "$WORKDIR/verify.json" 2>/dev/null || true)"
if [ "$verify_status" != "200" ]; then
  KEEP_WORKDIR=1
  die "all four steps applied, but GET /api/machines/$MACHINE_ID/api/health returned HTTP ${verify_status:-none}: $(cat "$WORKDIR/verify.json" 2>/dev/null)"
fi
VERIFIED_HOSTNAME="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1], encoding="utf-8")).get("hostname",""))' "$WORKDIR/verify.json")"
if [ "$VERIFIED_HOSTNAME" != "$REMOTE_HOSTNAME" ]; then
  KEEP_WORKDIR=1
  die "proxy health reports hostname '$VERIFIED_HOSTNAME' but ssh reached '$REMOTE_HOSTNAME' — the machine's baseUrl points somewhere else"
fi

say "done: $MACHINE_ID ($REMOTE_HOSTNAME) rotated; gateway proxy verified 200 via /api/machines/$MACHINE_ID/api/health"
say "the password was never printed; it lives only in $REMOTE_ENV on $REMOTE_HOSTNAME, $FLEET_ENV, and the gateway machine store"
