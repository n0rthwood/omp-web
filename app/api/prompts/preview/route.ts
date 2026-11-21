import { NextResponse } from "next/server";
import { requireAdminApi } from "@/app/api/web-users/_guard";
import { promptErrorResponse, validatePromptCwd } from "@/lib/prompt-api";
import { PromptStoreError, renderPromptExample } from "@/lib/prompt-store";
import { PROMPT_KEYS, type PromptPreview } from "@/lib/prompt-types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = await requireAdminApi(request);
  if (denied) return denied;
  try {
    const input = await request.json();
    await validatePromptCwd(input.cwd);
    if (!PROMPT_KEYS.includes(input.key) || typeof input.content !== "string" || Buffer.byteLength(input.content) > 256 * 1024) throw new PromptStoreError("Invalid prompt preview");
    const result: PromptPreview = input.key === "baseTemplate"
      ? { text: await renderPromptExample(input.content), kind: "example", note: "Example SDK render with no tools, skills, repository files or personality. This is not a live request; conditional branches depend on the real session." }
      : { text: input.content, kind: "literal", note: "Literal Markdown supplement. Template markers are not expanded. This preview does not run extensions or call a model." };
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return promptErrorResponse(error); }
}
