import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { NextResponse } from "next/server";
import packageJson from "../../../package.json";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getWebUserOrSynthetic } from "@/lib/web-auth-context";
import { isTerminalFeatureAvailable } from "@/lib/terminals/terminal-gate";
import type { MachineHealth } from "@/lib/api-types";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The SDK version, or `null` on any failure — health must never 500 over it.
 *
 * `createRequire` works unbundled, but the built Next server rewrites module
 * resolution, so the directory walk is the path that actually answers in
 * production: from this chunk's directory up to the filesystem root, looking
 * for the installed manifest.
 */
function readOmpVersion(): string | null {
  const candidates: string[] = [];
  try {
    candidates.push(createRequire(import.meta.url).resolve("@oh-my-pi/pi-coding-agent/package.json"));
  } catch {
    // Bundled: fall through to the directory walk.
  }

  let dir = import.meta.dirname || process.cwd();
  while (true) {
    candidates.push(join(dir, "node_modules", "@oh-my-pi", "pi-coding-agent", "package.json"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  for (const manifestPath of candidates) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (typeof manifest === "object" && manifest !== null && "version" in manifest) {
        const version = manifest.version;
        if (typeof version === "string") return version;
      }
    } catch {
      // Next candidate.
    }
  }
  return null;
}

// GET /api/health — machine health probe; no side effects, no network calls.
// Authenticated (the middleware gate applies), so a fleet gateway can use it
// to verify a stored credential in the same round trip.
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers: NO_STORE });
  }

  const user = await getWebUserOrSynthetic(req);
  const health: MachineHealth = {
    ok: true,
    ompWebVersion: packageJson.version,
    ompVersion: readOmpVersion(),
    hostname: hostname(),
    terminalsEnabled: isTerminalFeatureAvailable(),
    user: user ? { username: user.username, role: user.role } : null,
  };
  return NextResponse.json(health, { headers: NO_STORE });
}
