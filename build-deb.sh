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
