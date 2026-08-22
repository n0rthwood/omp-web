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
