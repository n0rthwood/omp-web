# Release Checklist

This repo has two independent release pipelines. They publish different
artifacts, on different tag schemes, to different places — do not conflate
them:

| Pipeline | Tag | Destination | GitHub Release object created? |
| --- | --- | --- | --- |
| **Debian package** (the one the fleet actually runs) | `omp-web-v<version>` | R2 apt repo `https://repo.joysort.cc/apt jammy main`, published by `.github/workflows/release.yml` ("Release Debian package") | **No.** Verified: `gh release list --repo n0rthwood/omp-web` returns no releases at all — this pipeline has never created one. |
| npm package `omp-web` (optional, only when explicitly requested) | `v<version>` | npmjs.org, published by `.github/workflows/publish-npm.yml` | No, by itself. A GitHub Release for a `v<version>` npm tag is a separate, manual step — see `.claude/skills/github-release/SKILL.md`. |

**Only the orchestrator bumps `debian/changelog` or `package.json`'s
`version` field.** This document is the checklist for whoever performs that
bump and tags the release; it is not an invitation for every contributor to
cut one.

## Debian package release (fleet-relevant)

1. Bump `debian/changelog` to the new version on `main` (`dch` or by hand).
   The release workflow enforces that the pushed tag's version matches
   `dpkg-parsechangelog -S Version` exactly and fails the build otherwise.
2. Tag and push:

   ```bash
   git tag omp-web-v<version>
   git push origin omp-web-v<version>
   ```

3. Watch the run:

   ```bash
   gh run list --repo n0rthwood/omp-web --workflow release.yml --limit 3
   gh run watch --repo n0rthwood/omp-web <run-id>
   ```

4. Verify the package landed in the apt repo:

   ```bash
   curl -fsS https://repo.joysort.cc/apt/dists/jammy/main/binary-amd64/Packages \
     | grep -A2 '^Package: omp-web$'
   ```

   Expected: `Version: <version>`.

5. There is no GitHub Release step here — this pipeline intentionally does
   not create one. If a human-readable release announcement is wanted on
   GitHub, that is a separate, explicit request; see
   `.claude/skills/github-release/SKILL.md`.

6. Roll the new version out to the fleet: `docs/fleet-deployment.md`'s
   "Apt upgrade (redeploy a remote)" section — one host at a time,
   active-session hosts last.

Full pipeline design and rationale (build/packaging internals, secrets
handling, the LXC fresh-install/upgrade/crash-recovery verification matrix):
`docs/plans/2026-08-20-omp-web-release-pipeline.md`.

## npm package release (optional)

`omp-web` also publishes to npm, on the separate `v<version>` tag scheme —
this is not part of the fleet's apt upgrade path and is not run by default.
See "npm publishing" in `.claude/skills/github-release/SKILL.md` for the
full checklist (preflight, publish, tag, and the optional GitHub Release on
`ddallabenetta/omp-web`).
