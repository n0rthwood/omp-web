import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { NextResponse } from "next/server";
import packageJson from "../../../package.json";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getWebUserOrSynthetic } from "@/lib/web-auth-context";
import { isTerminalFeatureAvailable } from "@/lib/terminals/terminal-gate";
import type { MachineHealth } from "@/lib/api-types";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** `null` on any resolution/read failure — health must never 500 over versions. */
function readOmpVersion(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const manifestPath = require.resolve("@oh-my-pi/pi-coding-agent/package.json");
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof manifest === "object" && manifest !== null && "version" in manifest) {
      const version = manifest.version;
      return typeof version === "string" ? version : null;
    }
    return null;
  } catch {
    return null;
  }
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
