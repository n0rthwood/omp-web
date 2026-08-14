import { NextResponse } from "next/server";
import { hasJsonContentType } from "@/lib/request-security";
import { createWebUserToken, readWebUsersConfig } from "@/lib/web-users";
import { jsonError, readJsonBody, requireAdminApi } from "../../_guard";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

type Params = { params: Promise<{ username: string }> };

// POST /api/web-users/[username]/tokens  body: { name }
// Returns the raw token exactly once — only its sha256 is stored.
export async function POST(req: Request, { params }: Params) {
  const denied = await requireAdminApi(req);
  if (denied) return denied;
  if (!hasJsonContentType(req)) {
    return jsonError(415, "Content-Type must be application/json");
  }
  const { username } = await params;

  const user = readWebUsersConfig().users.find((candidate) => candidate.username === username);
  if (!user) return jsonError(404, "User not found");

  const body = await readJsonBody(req);
  const name = body?.name;
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 64) {
    return jsonError(400, "name must be a non-empty string (max 64 chars)");
  }
  if (user.tokens.some((token) => token.name === name)) {
    return jsonError(409, "Token name already exists");
  }

  const token = createWebUserToken(username, name);
  if (!token) return jsonError(404, "User not found");
  return NextResponse.json(
    { name, raw: token.raw, created: token.created },
    { status: 201, headers: NO_STORE },
  );
}
