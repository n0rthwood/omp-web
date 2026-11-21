import { NextResponse } from "next/server";
import { requireAdminApi } from "@/app/api/web-users/_guard";
import { promptErrorResponse } from "@/lib/prompt-api";
import { PromptStoreError, readPromptMarker, loadPromptSnapshot } from "@/lib/prompt-store";
import { getSessionEntries, resolveSessionPath } from "@/lib/session-reader";
import { attachLiveHostIfExists, getRpcSession } from "@/lib/rpc-manager";
import { requireVisibleSession } from "@/lib/web-session-guard";
import type { PromptInspection } from "@/lib/prompt-types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await requireAdminApi(request);
  if (denied) return denied;
  try {
    const sessionId = new URL(request.url).searchParams.get("sessionId");
    if (!sessionId) throw new PromptStoreError("Select a conversation");
    const blocked = await requireVisibleSession(request, sessionId);
    if (blocked) return blocked;
    const file = await resolveSessionPath(sessionId);
    const rpc = getRpcSession(sessionId) ?? await attachLiveHostIfExists(sessionId);
    if (!file && !rpc) throw new PromptStoreError("Conversation not found", 404);
    const entries = file ? await getSessionEntries(file) : [];
    let profile: PromptInspection["profile"] = null;
    let status: PromptInspection["status"] = "legacy";
    let managedValues: PromptInspection["managedValues"] = null;
    let note: string | undefined;
    try { profile = readPromptMarker(entries); status = profile ? "managed" : "legacy"; }
    catch (error) { status = "unavailable"; note = error instanceof Error ? error.message : String(error); }
    if (profile) {
      try { managedValues = loadPromptSnapshot(profile).values; } catch (error) { status = "unavailable"; note = error instanceof Error ? error.message : String(error); }
    }
    let systemPromptBlocks: string[] | null = null;
    let observation = "Rendered context was not retained after this conversation's host exited. Recorded instruction messages from all journal branches are shown below.";
    if (rpc?.isAlive()) {
      try {
        const live = await rpc.send({ type: "get_prompt_inspection" }) as { systemPromptBlocks?: string[] };
        if (Array.isArray(live.systemPromptBlocks)) {
          systemPromptBlocks = live.systemPromptBlocks;
          observation = "Current SDK system state. This can change with tools/extensions; it is not a captured provider request.";
        }
      } catch (error) { observation = `Live prompt inspection unavailable: ${error instanceof Error ? error.message : String(error)}. Recorded instructions from all journal branches remain readable.`; }
    }
    const instructions: PromptInspection["instructions"] = [];
    for (const entry of entries) {
      const value = entry as unknown as { id?: string; type?: string; customType?: string; content?: unknown; message?: { role?: string; content?: unknown } };
      const role = value.message?.role ?? (value.type === "custom_message" ? "custom" : "");
      if (role !== "developer" && role !== "custom") continue;
      const content = value.message?.content ?? value.content;
      instructions.push({ id: value.id, role, source: value.customType ?? role, content: typeof content === "string" ? content : JSON.stringify(content, null, 2) });
    }
    const result: PromptInspection = { sessionId, profile, status, managedValues, systemPromptBlocks, observation, instructions, ...(note ? { note } : {}) };
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return promptErrorResponse(error); }
}
