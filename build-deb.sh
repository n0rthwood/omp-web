#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SEED_HOST="${OMP_WEB_SEED_HOST:-joysort@172.30.3.24}"

# No secret of any kind is sealed into the package any more (#74). The web
# password is generated per machine by debian/postinst, and provider API
# keys are the operator's to place in each host's ~/.omp/agent/.env.
echo "==> Fetching seed models.yml/config.yml from $SEED_HOST"
mkdir -p release/seeds
./release/seeds/fetch-seeds.sh "$SEED_HOST"

echo "==> Running dpkg-buildpackage"
dpkg-buildpackage -us -uc -b

VERSION="$(dpkg-parsechangelog -S Version)"
mkdir -p debian_dist
mv "../omp-web_${VERSION}_amd64.deb" "debian_dist/omp-web_${VERSION}_amd64.deb"
rm -f "../omp-web_${VERSION}_amd64.buildinfo" "../omp-web_${VERSION}_amd64.changes"

echo "==> Built debian_dist/omp-web_${VERSION}_amd64.deb"
