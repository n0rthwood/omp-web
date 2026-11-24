import { createReadStream, type Stats } from "node:fs";
import { extname } from "node:path";
import {
  resolveStaticMappingFile,
  StaticMappingError,
  type StaticMappingRecord,
} from "./static-mapping-store";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".eot": "application/vnd.ms-fontobject",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".xhtml": "application/xhtml+xml; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
};

export interface StaticMappingFileResolution {
  mapping: StaticMappingRecord;
  filePath: string;
  stat: Stats;
}

interface ByteRange {
  start: number;
  end: number;
}

function contentType(filePath: string): string {
  return MIME_BY_EXTENSION[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function entityTag(stat: Stats): string {
  return `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

function createBodyStream(filePath: string, range?: ByteRange): ReadableStream<Uint8Array> {
  const stream = createReadStream(filePath, range);
  let closed = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on("data", (chunk: Buffer) => {
        if (closed) return;
        try {
          controller.enqueue(new Uint8Array(chunk));
        } catch {
          closed = true;
          stream.destroy();
        }
      });
      stream.once("end", () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // The browser can cancel a download just as the stream ends.
        }
      });
      stream.once("error", (error) => {
        if (closed) return;
        closed = true;
        try {
          controller.error(error);
        } catch {
          // The browser already abandoned the response.
        }
      });
    },
    cancel() {
      closed = true;
      stream.destroy();
    },
  });
}

function parseRange(value: string | null, size: number): ByteRange | null | "invalid" {
  if (value === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || size === 0) return "invalid";
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!match[1] && match[2]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return "invalid";
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    return "invalid";
  }
  return { start, end: Math.min(end, size - 1) };
}

export const STATIC_DOCUMENT_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "font-src 'self' data:",
  "form-action 'none'",
  "frame-ancestors 'self'",
  "frame-src 'none'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "object-src 'none'",
  "script-src 'none'",
  "script-src-attr 'none'",
  "script-src-elem 'none'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'none'",
].join("; ");

function isStaticDocumentType(type: string): boolean {
  const mediaType = type.split(";", 1)[0].trim().toLowerCase();
  return mediaType === "text/html"
    || mediaType === "application/xhtml+xml"
    || mediaType === "image/svg+xml"
    || mediaType === "application/pdf"
    || mediaType === "application/xml"
    || mediaType === "text/xml";
}

function commonHeaders(stat: Stats, type: string): Headers {
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-cache, must-revalidate",
    "Content-Type": type,
    ETag: entityTag(stat),
    "Last-Modified": stat.mtime.toUTCString(),
    "X-Content-Type-Options": "nosniff",
  });
  if (isStaticDocumentType(type)) {
    headers.set("Content-Security-Policy", STATIC_DOCUMENT_CSP);
  }
  return headers;
}

/** Enforce the same policy on bytes streamed by an older remote instance. */
export function enforceStaticDocumentPolicy(response: Response): Response {
  const type = response.headers.get("content-type") ?? "";
  if (!isStaticDocumentType(type)) return response;
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", STATIC_DOCUMENT_CSP);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function notModified(request: Request, headers: Headers): boolean {
  const tag = request.headers.get("if-none-match");
  if (tag && tag === headers.get("etag")) return true;
  const since = request.headers.get("if-modified-since");
  const modified = headers.get("last-modified");
  return Boolean(since && modified && Date.parse(since) >= Date.parse(modified));
}

export function serveStaticMappingFile(request: Request, mappingId: string, segments: readonly string[]): Response {
  let resolved: StaticMappingFileResolution | null;
  try {
    resolved = resolveStaticMappingFile(mappingId, segments);
  } catch (error) {
    if (error instanceof StaticMappingError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.status,
        headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
      });
    }
    throw error;
  }
  if (!resolved) return new Response("Not found", { status: 404 });

  const { filePath, stat } = resolved;
  const headers = commonHeaders(stat, contentType(filePath));
  if (notModified(request, headers)) return new Response(null, { status: 304, headers });

  const range = parseRange(request.headers.get("range"), stat.size);
  if (range === "invalid") {
    headers.set("Content-Range", `bytes */${stat.size}`);
    return new Response(null, { status: 416, headers });
  }
  if (range === null) {
    headers.set("Content-Length", String(stat.size));
    return new Response(createBodyStream(filePath), { status: 200, headers });
  }

  const length = range.end - range.start + 1;
  headers.set("Content-Length", String(length));
  headers.set("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`);
  return new Response(createBodyStream(filePath, range), { status: 206, headers });
}
