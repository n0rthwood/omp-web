import { NextResponse } from "next/server";
import { hasJsonContentType } from "@/lib/request-security";
import { pruneMachineGrants } from "@/lib/machines/machine-grants";
import { revokeSessionsForUser } from "@/lib/web-sessions";
import {
  countEffectiveAdmins,
  deleteWebUser,
  hashWebPassword,
  readWebUsersConfig,
  updateWebUser,
  type StoredWebUser,
  type WebUserUpdate,
} from "@/lib/web-users";
import { jsonError, parseMachines, parseProjects, parseRole, readJsonBody, requireAdminApi } from "../_guard";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

type Params = { params: Promise<{ username: string }> };

function toSafeUser(user: StoredWebUser) {
  return {
    username: user.username,
    role: user.role,
    projects: user.projects,
    machines: pruneMachineGrants(user.machines),
    tokens: user.tokens.map(({ name, created }) => ({ name, created })),
  };
}

function findFileUser(username: string): StoredWebUser | null {
  return readWebUsersConfig().users.find((candidate) => candidate.username === username) ?? null;
}

// PATCH /api/web-users/[username]  body: { role?, projects?, password? }
export async function PATCH(req: Request, { params }: Params) {
  const denied = await requireAdminApi(req);
  if (denied) return denied;
  if (!hasJsonContentType(req)) {
    return jsonError(415, "Content-Type must be application/json");
  }
  const { username } = await params;
  const existing = findFileUser(username);
  // The env-backed migration admin is not a file user and cannot be edited.
  if (!existing) return jsonError(404, "User not found");

  const body = await readJsonBody(req);
  if (!body) return jsonError(400, "Invalid JSON body");

  const update: WebUserUpdate = {};
  if (body.role !== undefined) {
    const role = parseRole(body.role);
    if (!role) return jsonError(400, "role must be \"admin\" or \"user\"");
    update.role = role;
  }
  if (body.projects !== undefined) {
    const projects = parseProjects(body.projects);
    if (!projects.ok) {
      return jsonError(400, "projects must be \"*\" or an array of absolute paths");
    }
    update.projects = projects.projects;
  }
  if (body.machines !== undefined) {
    const machines = parseMachines(body.machines);
    if (!machines.ok) {
      return jsonError(400, "machines must be \"*\" or an array of machine ids");
    }
    update.machines = machines.machines;
  }
  if (body.password !== undefined) {
    if (typeof body.password !== "string" || body.password.length === 0) {
      return jsonError(400, "password must be a non-empty string");
    }
    update.passwordHash = hashWebPassword(body.password);
  }

  // Last-admin guard: never let the effective admin count drop to zero.
  const nextRole = update.role ?? existing.role;
  if (existing.role === "admin" && nextRole !== "admin") {
    const usersAfter = readWebUsersConfig().users.map((user) =>
      user === existing ? { ...user, role: nextRole } : user,
    );
    if (countEffectiveAdmins(usersAfter) === 0) {
      return jsonError(409, "Cannot demote the last admin");
    }
  }

  const updated = updateWebUser(username, update);
  if (!updated) return jsonError(404, "User not found");
  return NextResponse.json({ user: toSafeUser(updated) }, { headers: NO_STORE });
}

// DELETE /api/web-users/[username]
export async function DELETE(req: Request, { params }: Params) {
  const denied = await requireAdminApi(req);
  if (denied) return denied;
  const { username } = await params;
  const existing = findFileUser(username);
  if (!existing) return jsonError(404, "User not found");

  const usersAfter = readWebUsersConfig().users.filter((user) => user !== existing);
  if (countEffectiveAdmins(usersAfter) === 0) {
    return jsonError(409, "Cannot delete the last admin");
  }

  deleteWebUser(username);
  revokeSessionsForUser(username);
  return NextResponse.json({ success: true }, { headers: NO_STORE });
}
