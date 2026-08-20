import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { isApiRequestAllowed } from "@/lib/request-security";
import { requireVisibleSession } from "@/lib/web-session-guard";
import { resolveSessionPath } from "@/lib/session-reader";
import { parseFormDataWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { allowFileRoot } from "@/lib/file-access";
import {
  isBinaryUploadName,
  looksBinaryHeader,
  nextAvailableUploadPath,
  validateUploadFileNames,
} from "@/lib/file-upload";

// Same caps as the workspace file-browser uploader (app/api/files/[...path]).
const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024;
// Multipart boundaries and headers are not file bytes, but must be bounded too.
const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_TOTAL_BYTES + 1024 * 1024;

// Session ids are uuids; this also keeps the id out of the upload directory
// path unmodified, so it can never smuggle a traversal segment.
const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

/** Write `bytes` under `dir` as `name`, suffixing on a losing `wx` race. */
function writeUploadFile(dir: string, name: string, bytes: Buffer): string {
  let dest = nextAvailableUploadPath(dir, name);
  for (;;) {
    try {
      fs.writeFileSync(dest, bytes, { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        dest = nextAvailableUploadPath(dir, path.basename(dest));
        continue;
      }
      throw error;
    }
  }
  fs.chmodSync(dest, 0o600);
  return dest;
}

// POST /api/agent/[id]/uploads - Attach text files to a chat session.
//
// Files land in a permanent, workspace-external directory
// (~/.omp/agent/uploads/<sessionId>/) rather than the session's cwd, so an
// upload never writes into a user's project tree. The client inserts an
// `@"<absolute path>"` mention for each accepted file; the SDK's own
// @-mention pipeline resolves absolute paths as-is regardless of cwd.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const { id } = await params;
  const blocked = await requireVisibleSession(request, id);
  if (blocked) return blocked;

  const filePath = await resolveSessionPath(id);
  if (!filePath) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  let formData: FormData;
  try {
    formData = await parseFormDataWithinLimit(request, MAX_UPLOAD_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Uploads must total 100MB or less" }, { status: 413 });
    }
    throw error;
  }

  const files = formData.getAll("files").filter((entry): entry is File => typeof entry !== "string");
  if (files.some((file) => file.size > MAX_UPLOAD_FILE_BYTES)) {
    return NextResponse.json({ error: "Each upload must be 25MB or smaller" }, { status: 413 });
  }
  if (files.reduce((total, file) => total + file.size, 0) > MAX_UPLOAD_TOTAL_BYTES) {
    return NextResponse.json({ error: "Uploads must total 100MB or less" }, { status: 413 });
  }

  const validationError = validateUploadFileNames(files.map((file) => file.name));
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  if (!SESSION_ID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid session id" }, { status: 400 });
  }

  const dir = path.join(getAgentDir(), "uploads", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o700);

  const uploaded: Array<{ name: string; path: string; size: number }> = [];
  const errors: Array<{ name: string; error: string }> = [];

  for (const file of files) {
    if (isBinaryUploadName(file.name)) {
      errors.push({ name: file.name, error: `${file.name}: binary file not supported for chat upload` });
      continue;
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(await file.arrayBuffer());
    } catch (error) {
      errors.push({ name: file.name, error: error instanceof Error ? error.message : String(error) });
      continue;
    }

    if (looksBinaryHeader(bytes)) {
      errors.push({ name: file.name, error: `${file.name}: binary file not supported for chat upload` });
      continue;
    }

    try {
      const dest = writeUploadFile(dir, file.name, bytes);
      uploaded.push({ name: path.basename(dest), path: dest, size: bytes.byteLength });
    } catch (error) {
      errors.push({ name: file.name, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (uploaded.length > 0) {
    allowFileRoot(dir);
  }

  return NextResponse.json(
    { files: uploaded, ...(errors.length > 0 ? { errors } : {}) },
    { status: errors.length > 0 ? 207 : 200 },
  );
}
