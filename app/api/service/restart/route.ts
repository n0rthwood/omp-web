import { NextResponse } from "next/server";
import { getRestartServiceAvailability, startRestartServiceRun } from "@/lib/restart-service";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** Admin-only through the shared proxy policy; this handler probes local daemon state. */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers: NO_STORE });
  }

  try {
    return NextResponse.json(await getRestartServiceAvailability(), { headers: NO_STORE });
  } catch {
    return NextResponse.json(
      { available: false, reason: "restart service unavailable" },
      { headers: NO_STORE },
    );
  }
}

/** Start an authenticated restart-service run without exposing the host token. */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers: NO_STORE });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json(
      { error: "Content-Type must be application/json" },
      { status: 415, headers: NO_STORE },
    );
  }

  let mode: unknown;
  try {
    ({ mode } = await req.json());
  } catch {
    return NextResponse.json({ error: "invalid mode" }, { status: 400, headers: NO_STORE });
  }
  if (mode !== "restart" && mode !== "upgrade") {
    return NextResponse.json({ error: "invalid mode" }, { status: 400, headers: NO_STORE });
  }

  try {
    const result = await startRestartServiceRun(mode);
    switch (result.kind) {
      case "started":
        return NextResponse.json(
          {
            started: true,
            run_id: result.body.run_id ?? null,
            pid: result.body.pid ?? null,
          },
          { status: 202, headers: NO_STORE },
        );
      case "in-progress":
        return NextResponse.json(
          { error: "run already in progress", status: result.status },
          { status: 409, headers: NO_STORE },
        );
      case "rejected-token":
        return NextResponse.json(
          { error: "restart service rejected token" },
          { status: 502, headers: NO_STORE },
        );
      case "unavailable":
        return NextResponse.json(
          { available: false, reason: result.reason },
          { status: 503, headers: NO_STORE },
        );
      case "daemon-error":
        return NextResponse.json(
          { error: `restart service returned HTTP ${result.status}` },
          { status: 502, headers: NO_STORE },
        );
    }
  } catch {
    return NextResponse.json(
      { available: false, reason: "restart service unavailable" },
      { status: 503, headers: NO_STORE },
    );
  }
}
