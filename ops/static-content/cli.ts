import {
  getStaticPublicMachineId,
  listStaticMappings,
  revokeStaticMapping,
  staticMappingResponse,
  StaticMappingError,
  isStaticMappingError,
  createStaticMapping,
  resolveStaticProjectRoot,
  updateStaticMapping,
} from "../../lib/static-mapping-store";
import { parseStaticMappingCreateInput, parseStaticMappingPatchInput } from "../../lib/static-mapping-http";

export type StaticContentCommand = "create" | "list" | "update" | "revoke";
export interface StaticContentCommandRequest {
  command?: unknown;
  op?: unknown;
  action?: unknown;
  input?: unknown;
  patch?: unknown;
  mapping?: unknown;
  id?: unknown;
  mappingId?: unknown;
  content?: unknown;
  [key: string]: unknown;
}

const CREATE_FIELDS: Record<string, true> = {
  id: true,
  label: true,
  lifecycle: true,
  persistent: true,
  ttlSeconds: true,
  expiresAt: true,
  sessionId: true,
  entryFile: true,
  projectRoot: true,
};
const PATCH_FIELDS: Record<string, true> = {
  label: true,
  lifecycle: true,
  persistent: true,
  ttlSeconds: true,
  expiresAt: true,
  entryFile: true,
};
const REVOKE_FIELDS: Record<string, true> = {
  content: true,
};

function mergeFields(...fields: Record<string, true>[]): Record<string, true> {
  return Object.assign({}, ...fields);
}


const COMMAND_FIELDS: Record<StaticContentCommand, Record<string, true>> = {
  create: mergeFields(
    { command: true, op: true, action: true, input: true, patch: true, mapping: true },
    CREATE_FIELDS,
  ),
  list: { command: true, op: true, action: true },
  update: mergeFields(
    { command: true, op: true, action: true, input: true, patch: true, mapping: true, id: true, mappingId: true },
    PATCH_FIELDS,
  ),
  revoke: mergeFields(
    { command: true, op: true, action: true, input: true, patch: true, mapping: true, id: true, mappingId: true },
    REVOKE_FIELDS,
  ),
};


function rejectUnknownFields(value: Record<string, unknown>, allowed: Record<string, true>, where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed[key]) throw new StaticMappingError(`${where} contains unsupported field: ${key}`, 400, key);
  }
}

function commandName(request: StaticContentCommandRequest): StaticContentCommand {
  const values = [request.command, request.op, request.action].filter((value) => value !== undefined);
  if (values.length === 0 || values.some((value) => typeof value !== "string")) {
    throw new StaticMappingError("command must be create, list, update, or revoke", 400, "command");
  }
  const first = values[0] as string;
  if (values.some((value) => value !== first)) {
    throw new StaticMappingError("command, op, and action must agree", 400, "command");
  }
  if (first !== "create" && first !== "list" && first !== "update" && first !== "revoke") {
    throw new StaticMappingError("command must be create, list, update, or revoke", 400, "command");
  }
  return first;
}

function nestedInput(request: StaticContentCommandRequest): Record<string, unknown> | undefined {
  const candidates = [request.input, request.patch, request.mapping].filter((value) => value !== undefined);
  if (candidates.length > 1) throw new StaticMappingError("provide only one of input, patch, or mapping", 400, "input");
  if (candidates.length === 0) return undefined;
  const candidate = candidates[0];
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new StaticMappingError("input must be a JSON object", 400, "input");
  }
  return candidate as Record<string, unknown>;
}

function directFields(
  request: StaticContentCommandRequest,
  allowed: Record<string, true>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request)) {
    if (allowed[key] && value !== undefined) values[key] = value;
  }
  return values;
}

function mutationInput(
  request: StaticContentCommandRequest,
  allowed: Record<string, true>,
): Record<string, unknown> {
  const nested = nestedInput(request);
  if (nested) rejectUnknownFields(nested, allowed, "input");
  return { ...(nested ?? {}), ...directFields(request, allowed) };
}

function mappingId(request: StaticContentCommandRequest): string {
  const id = request.id ?? request.mappingId;
  if (request.id !== undefined && request.mappingId !== undefined && request.id !== request.mappingId) {
    throw new StaticMappingError("id and mappingId must agree", 400, "id");
  }
  if (typeof id !== "string" || id.length === 0) {
    throw new StaticMappingError("id is required", 400, "id");
  }
  return id;
}

function revokeContent(request: StaticContentCommandRequest): "delete" | "retain" {
  const nested = nestedInput(request);
  if (nested) rejectUnknownFields(nested, REVOKE_FIELDS, "input");
  const nestedContent = nested?.content;
  if (request.content !== undefined && nestedContent !== undefined && request.content !== nestedContent) {
    throw new StaticMappingError("content values must agree", 400, "content");
  }
  const content = request.content ?? nestedContent ?? "retain";
  if (content !== "delete" && content !== "retain") {
    throw new StaticMappingError("content must be delete or retain", 400, "content");
  }
  return content;
}

/**
 * Execute one same-user local command without HTTP, cookies, or browser state.
 * The store resolves and validates the explicit project root before the
 * mapping is persisted.
 */
export async function executeStaticContentCommand(value: unknown): Promise<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StaticMappingError("command must be a JSON object", 400, "command");
  }
  const request = value as StaticContentCommandRequest;
  const command = commandName(request);
  rejectUnknownFields(value as Record<string, unknown>, COMMAND_FIELDS[command], "command");

  if (command === "list") {
    return {
      machineId: getStaticPublicMachineId(),
      mappings: listStaticMappings().map(staticMappingResponse),
    };
  }

  if (command === "create") {
    const input = mutationInput(request, CREATE_FIELDS);
    const parsed = parseStaticMappingCreateInput(input);
    const projectRoot = await resolveStaticProjectRoot(parsed.projectRoot);
    const mapping = staticMappingResponse(createStaticMapping({ ...parsed, projectRoot }));
    return { mapping, writeDir: mapping.writeDir, publicPath: mapping.publicPath };
  }

  if (command === "update") {
    const id = mappingId(request);
    const input = mutationInput(request, PATCH_FIELDS);
    const mapping = updateStaticMapping(id, parseStaticMappingPatchInput(input));
    if (!mapping) throw new StaticMappingError("Static mapping not found", 404, "id");
    const response = staticMappingResponse(mapping);
    return { mapping: response, writeDir: response.writeDir, publicPath: response.publicPath };
  }

  const id = mappingId(request);
  const content = revokeContent(request);
  const result = revokeStaticMapping(id, content);
  if (!result) throw new StaticMappingError("Static mapping not found", 404, "id");
  const response = staticMappingResponse(result.mapping);
  return {
    ok: true,
    id,
    contentDeleted: result.contentDeleted,
    mapping: response,
    writeDir: response.writeDir,
    publicPath: response.publicPath,
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function readRequest(): Promise<unknown> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    const input = await readStdin();
    if (!input) throw new StaticMappingError("provide one JSON command on stdin", 400, "command");
    return JSON.parse(input) as unknown;
  }
  if (args.length === 1) return JSON.parse(args[0]) as unknown;
  if (args.length === 2 && ["create", "list", "update", "revoke"].includes(args[0])) {
    const parsed = JSON.parse(args[1]) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new StaticMappingError("command JSON must be an object", 400, "command");
    }
    const parsedObject = parsed as Record<string, unknown>;
    return { ...parsedObject, command: parsedObject.command ?? args[0] };
  }
  throw new StaticMappingError("usage: cli.ts '<json>' or cli.ts <command> '<json>'", 400, "command");
}

async function main(): Promise<void> {
  try {
    const result = await executeStaticContentCommand(await readRequest());
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const status = isStaticMappingError(error) ? error.status : error instanceof SyntaxError ? 400 : 500;
    const message = error instanceof SyntaxError ? "command must contain valid JSON" : error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ error: message, status })}\n`);
    process.exitCode = status >= 500 ? 1 : 2;
  }
}

if (import.meta.main) void main();

