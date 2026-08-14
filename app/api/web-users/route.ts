import { NextResponse } from "next/server";
import { hasJsonContentType } from "@/lib/request-security";
import {
  createWebUser,
  getEffectiveWebUsers,
  hashWebPassword,
  isValidWebUsername,
  type EffectiveWebUser,
} from "@/lib/web-users";
import { jsonError, parseProjects, parseRole, readJsonBody, requireAdminApi } from "./_guard";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** Safe projection for listings — never password hashes or token hashes. */
function toListedUser(user: EffectiveWebUser) {
  return {
    username: user.username,
    role: user.role,
    projects: user.projects,
    tokens: user.tokens.map(({ name, created }) => ({ name, created })),
    envBacked: user.envBacked,
  };
}

// GET /api/web-users — list users (safe fields only)
export async function GET(req: Request) {
  const denied = await requireAdminApi(req);
  if (denied) return denied;
  return NextResponse.json({ users: getEffectiveWebUsers().map(toListedUser) }, { headers: NO_STORE });
}

// POST /api/web-users  body: { username, password, role, projects }
export async function POST(req: Request) {
  const denied = await requireAdminApi(req);
  if (denied) return denied;
  if (!hasJsonContentType(req)) {
    return jsonError(415, "Content-Type must be application/json");
  }

  const body = await readJsonBody(req);
  if (!body) return jsonError(400, "Invalid JSON body");

  const { username, password, role, projects } = body;
  if (typeof username !== "string" || !isValidWebUsername(username)) {
    return jsonError(400, "username must match [a-z0-9_-]{1,32}");
  }
  if (typeof password !== "string" || password.length === 0) {
    return jsonError(400, "password is required");
  }
  const parsedRole = parseRole(role);
  if (!parsedRole) return jsonError(400, "role must be \"admin\" or \"user\"");
  const parsedProjects = parseProjects(projects);
  if (!parsedProjects.ok) {
    return jsonError(400, "projects must be \"*\" or an array of absolute paths");
  }

  const created = createWebUser({
    username,
    role: parsedRole,
    passwordHash: hashWebPassword(password),
    projects: parsedProjects.projects,
    tokens: [],
  });
  if (!created) return jsonError(400, "Username already exists");

  return NextResponse.json(
    {
      user: {
        username,
        role: parsedRole,
        projects: parsedProjects.projects,
        tokens: [] as { name: string; created: string }[],
      },
    },
    { status: 201, headers: NO_STORE },
  );
}
