import { realpathSync, statSync } from "node:fs";
import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "./file-access";
import { PromptStoreError } from "./prompt-store";

export async function validatePromptCwd(value: unknown): Promise<string | null> {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new PromptStoreError("Invalid project directory");
  const roots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(value, roots)) throw new PromptStoreError("Access denied", 403);
  const cwd = realpathSync(value);
  if (!statSync(cwd).isDirectory()) throw new PromptStoreError("Project must be a directory");
  return cwd;
}

export function promptErrorResponse(error: unknown): NextResponse {
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: error instanceof PromptStoreError ? error.status : 500, headers: { "Cache-Control": "no-store" } });
}
