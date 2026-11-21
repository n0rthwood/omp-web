import { NextResponse } from "next/server";
import { requireAdminApi } from "@/app/api/web-users/_guard";
import { promptErrorResponse, validatePromptCwd } from "@/lib/prompt-api";
import { readPromptCatalog, savePromptDefaults } from "@/lib/prompt-store";
import type { PromptSaveRequest } from "@/lib/prompt-types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await requireAdminApi(request);
  if (denied) return denied;
  try {
    const cwd = await validatePromptCwd(new URL(request.url).searchParams.get("cwd"));
    return NextResponse.json(await readPromptCatalog(cwd), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return promptErrorResponse(error); }
}

export async function PUT(request: Request) {
  const denied = await requireAdminApi(request);
  if (denied) return denied;
  try {
    const input = await request.json() as PromptSaveRequest;
    const cwd = await validatePromptCwd(input.cwd);
    await savePromptDefaults({ ...input, cwd });
    return NextResponse.json(await readPromptCatalog(cwd), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return promptErrorResponse(error); }
}
