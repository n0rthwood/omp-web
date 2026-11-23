import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { promisify } from "util";
import { fileURLToPath, pathToFileURL } from "url";
import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { resolveSessionPath } from "@/lib/session-reader";
import { requireVisibleSession } from "@/lib/web-session-guard";

const execFileAsync = promisify(execFile);

export const runtime = "nodejs";

type ExportHtmlModule = {
  exportFromFile: (inputPath: string, outputPath: string) => Promise<string>;
};

async function getOmpPackageDir(): Promise<string | null> {
  try {
    // `getPackageDir` returns undefined inside `bun --compile` binaries, where
    // omp's package assets are not on disk at all.
    const { getPackageDir } = await import("@oh-my-pi/pi-coding-agent/config");
    return getPackageDir() ?? null;
  } catch {
    return null;
  }
}

function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function getContentDisposition(fileName: string, inline: boolean): string {
  const fallback = fileName.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "session.html";
  const disposition = inline ? "inline" : "attachment";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeHeaderValue(fileName)}`;
}

const SESSION_DATA_SCRIPT_RE =
  /<script id="session-data" type="application\/json">([^<]*)<\/script>/;

/**
 * The omp CLI export embeds the raw journal (base64 JSON) in a session-data
 * script tag; the remote viewer renders out-of-band `type:"custom"` marker
 * entries (tool_execution_start, system-prompt-digest, omp-web:prompt-profile,
 * …) as empty rows. Drop ONLY those markers, keeping every rendered message
 * and metadata entry (message/custom_message/model_usage/title_change/…).
 * Custom markers sit IN the parentId chain, and the viewer's buildTree pushes
 * unknown-parent nodes as roots — so kept entries whose parent was dropped
 * are re-linked to the nearest surviving ancestor (null ⇒ root) first.
 * Any failure (missing tag, malformed base64/JSON, unexpected shape) returns
 * the original html unchanged — export must never fail because of the filter.
 */
export function stripCustomEntriesFromExportHtml(html: string): string {
  try {
    const match = SESSION_DATA_SCRIPT_RE.exec(html);
    if (!match) return html;
    const encoded = match[1].replace(/\s+/g, "");
    const decoded = Buffer.from(encoded, "base64");
    // Buffer.from silently skips invalid base64 characters; require a clean
    // round-trip (padding-insensitive) so malformed payloads fall back.
    const stripPad = (value: string) => value.replace(/=+$/, "");
    if (stripPad(decoded.toString("base64")) !== stripPad(encoded)) return html;
    const data: unknown = JSON.parse(decoded.toString("utf8"));
    if (!data || typeof data !== "object") return html;
    const entries = (data as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return html;
    const isCustom = (entry: unknown): boolean =>
      !!entry && typeof entry === "object" && (entry as { type?: unknown }).type === "custom";
    const byId = new Map<string, Record<string, unknown>>();
    for (const entry of entries) {
      if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        if (typeof record.id === "string") byId.set(record.id, record);
      }
    }
    const droppedIds = new Set<string>();
    for (const [id, record] of byId) if (isCustom(record)) droppedIds.add(id);
    // Walk a dropped parent chain up to the nearest surviving ancestor.
    const resolveParent = (parentId: unknown): unknown => {
      const seen = new Set<string>();
      let current = parentId;
      while (typeof current === "string" && droppedIds.has(current)) {
        if (seen.has(current)) return null; // cycle guard
        seen.add(current);
        current = byId.get(current)?.parentId ?? null;
      }
      return current;
    };
    const kept = entries
      .filter((entry) => !isCustom(entry))
      .map((entry) => {
        const record = entry as Record<string, unknown>;
        const parentId = record.parentId;
        if (typeof parentId === "string" && droppedIds.has(parentId)) {
          return { ...record, parentId: resolveParent(parentId) };
        }
        return entry;
      });
    if (kept.length === entries.length) return html;
    const patched: Record<string, unknown> = { ...(data as Record<string, unknown>), entries: kept };
    // The viewer navigates to data.leafId on boot (unknown id ⇒ blank
    // transcript); the journal leaf is frequently a custom marker, so remap
    // it through the same ancestor walk. subSessions carry their own
    // entries/leafId pairs and are left untouched.
    if (typeof patched.leafId === "string" && droppedIds.has(patched.leafId)) {
      patched.leafId = resolveParent(patched.leafId);
    }
    const reencoded = Buffer.from(JSON.stringify(patched), "utf8").toString("base64");
    return (
      html.slice(0, match.index) +
      `<script id="session-data" type="application/json">${reencoded}</script>` +
      html.slice(match.index + match[0].length)
    );
  } catch {
    return html;
  }
}

async function getOmpCliPath(): Promise<string | null> {
  const candidates = new Set<string>();
  const packageDir = await getOmpPackageDir();

  if (packageDir) {
    candidates.add(join(packageDir, "dist", "cli.js"));
  }

  try {
    const resolver = (import.meta as ImportMeta & {
      resolve?: (specifier: string) => string | Promise<string>;
    }).resolve;
    if (typeof resolver === "function") {
      const indexUrl = await resolver("@oh-my-pi/pi-coding-agent");
      candidates.add(join(dirname(fileURLToPath(indexUrl)), "cli.js"));
    }
  } catch {
    // Next.js production bundles can strip import.meta.resolve.
  }

  candidates.add(
    join(
      process.cwd(),
      "node_modules",
      "@oh-my-pi",
      "pi-coding-agent",
      "dist",
      "cli.js"
    )
  );

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}


async function exportSession(filePath: string, outputPath: string): Promise<void> {
  const cliPath = await getOmpCliPath();
  if (cliPath) {
    await execFileAsync(process.execPath, [cliPath, "--export", filePath, outputPath], {
      cwd: process.cwd(),
      timeout: 30_000,
      env: {
        ...process.env,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
      },
      maxBuffer: 1024 * 1024,
    });
    return;
  }

  const packageDir = await getOmpPackageDir();
  if (!packageDir) throw new Error("pi CLI not found");

  const exporterUrl = pathToFileURL(join(packageDir, "dist", "core", "export-html", "index.js")).href;
  const { exportFromFile } = (await import(exporterUrl)) as ExportHtmlModule;
  await exportFromFile(filePath, outputPath);
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const blocked = await requireVisibleSession(req, id);
  if (blocked) return blocked;

  const inline = new URL(req.url).searchParams.get("inline") === "1";

  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const tempDir = join(tmpdir(), "omp-web-export");
    mkdirSync(tempDir, { recursive: true });

    const sessionBase = basename(filePath, ".jsonl");
    const fileName = `pi-session-${sessionBase}.html`;
    const outputPath = join(tempDir, `${randomUUID()}.html`);

    try {
      await exportSession(filePath, outputPath);

      const html = readFileSync(outputPath, "utf8");
      return new Response(stripCustomEntriesFromExportHtml(html), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": getContentDisposition(fileName, inline),
          "Cache-Control": "no-cache",
          "Content-Security-Policy": "frame-ancestors 'none'",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
        },
      });
    } finally {
      rmSync(outputPath, { force: true });
    }
  } catch {
    return NextResponse.json({ error: "Unable to export session" }, { status: 500 });
  }
}
