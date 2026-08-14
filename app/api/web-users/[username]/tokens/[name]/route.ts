import { NextResponse } from "next/server";
import { deleteWebUserToken } from "@/lib/web-users";
import { jsonError, requireAdminApi } from "../../../_guard";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ username: string; name: string }> };

// DELETE /api/web-users/[username]/tokens/[name]
export async function DELETE(req: Request, { params }: Params) {
  const denied = await requireAdminApi(req);
  if (denied) return denied;
  const { username, name } = await params;

  if (!deleteWebUserToken(username, name)) return jsonError(404, "Token not found");
  return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
}
