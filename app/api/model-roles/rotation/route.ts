import { NextResponse } from "next/server";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import {
  readRotationState,
  writeRotationState,
  type ModelRotationState,
} from "@/lib/model-rotation";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/** GET /api/model-roles/rotation — the rotation switches and current cursors. */
export async function GET() {
  try {
    return NextResponse.json({ rotation: readRotationState(getAgentDir()) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

/**
 * PUT /api/model-roles/rotation  body: { enabled?, role?, rotate? }
 *
 * Flips the master switch, a single role's opt-in, or both. Cursors are owned by
 * session creation and are never written here — resetting them from the UI would
 * make two conversations started either side of the edit draw the same entry.
 *
 * Turning a role off leaves its cursor in place so re-enabling resumes the
 * rotation where it stopped rather than replaying entries already used.
 */
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as { enabled?: unknown; role?: unknown; rotate?: unknown };
    const agentDir = getAgentDir();
    const current = readRotationState(agentDir);
    const next: ModelRotationState = {
      enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled,
      roles: { ...current.roles },
      cursors: { ...current.cursors },
    };

    if (body.role !== undefined) {
      if (typeof body.role !== "string" || !body.role.trim()) {
        return NextResponse.json({ error: "role must be a non-empty string" }, { status: 400 });
      }
      if (typeof body.rotate !== "boolean") {
        return NextResponse.json({ error: "rotate must be a boolean when role is given" }, { status: 400 });
      }
      next.roles[body.role.trim()] = body.rotate;
    }

    writeRotationState(agentDir, next);
    return NextResponse.json({ rotation: next });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
