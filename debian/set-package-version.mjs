#!/usr/bin/env bun
// Stamps package.json's "version" field from debian/changelog so the value
// baked into NEXT_PUBLIC_APP_VERSION (next.config.ts) and reported by
// /api/health (app/api/health/route.ts) matches the .deb actually being
// built, instead of the hand-maintained value committed to git (#32).
//
// Invoked from debian/rules override_dh_auto_build, after `bun install` and
// before `bun run build`, with the resolved changelog version as argv[2].
// Runs against a working tree; never committed back. A plain regex swap on
// the single top-level "version" line keeps the rest of the file byte-for-
// byte identical and makes repeated invocations a no-op once the value
// already matches (idempotent across `dpkg-buildpackage` re-runs).
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!version) {
  throw new Error("set-package-version: missing version argument");
}

const path = "package.json";
const text = readFileSync(path, "utf8");
const pattern = /^(\s*"version":\s*")[^"]*(")/m;
if (!pattern.test(text)) {
  throw new Error(`set-package-version: no "version" field found in ${path}`);
}

const patched = text.replace(pattern, `$1${version}$2`);
if (patched !== text) {
  writeFileSync(path, patched);
}
