# Web Authentication and Users

omp-web fronts a high-privilege agent, so every request needs a valid credential once authentication is enabled. There are three ways to authenticate:

1. **Cookie login** — username/password at the `/login` page, for browsers and the installed PWA.
2. **Bearer tokens** — `Authorization: Bearer web_…`, for scripts and CLIs.
3. **Basic Auth (migration bridge)** — the legacy `OMP_WEB_PASSWORD` environment variable, kept working so existing deployments don't break while you move to web users.

When no users are configured and `OMP_WEB_PASSWORD` is unset, authentication is disabled entirely and omp-web behaves as before (a synthetic admin identity serves every request).

There is deliberately **no loopback or "local client" exception**: when auth is enabled, every request — including `curl` from the same machine — needs a cookie, a token, or the env password.

## Cookie login

Open the omp-web URL unauthenticated and the app redirects to `/login`. Sign in with a username and password from the web users store (see below).

- `POST /api/auth/web-login` with `{ "username": "...", "password": "..." }` exchanges credentials for a session cookie.
- The cookie (`omp-web-session`) is `HttpOnly` and `SameSite=Lax`, host-only (no `Domain` attribute, so it never leaks to sibling subdomains), and marked `Secure` whenever the request host is not a loopback literal (`localhost`, `127.0.0.1`, `::1`).
- The cookie holds an opaque random id. The server keeps the actual session state in `~/.omp/agent/omp-web-sessions.json`, keyed by the SHA-256 of that id — stealing a database listing doesn't get you reusable cookies.
- Sessions have a **sliding TTL**, 30 days by default (`sessions.ttlDays` in the users file, below). Each lookup extends the expiry when the session has been idle for an hour or more.
- `GET /api/auth/web-me` reports the current identity: `{ "user": { "username": "...", "role": "...", "visibleProjects": ... }, "authRequired": true }` — `user` is `null` when unauthenticated, and `authRequired` distinguishes a logged-out browser from an install with auth disabled.
- `POST /api/auth/web-logout` revokes the server-side session and clears the cookie.
- Failed logins are throttled per username: 5 consecutive failures lock that username out for 30 seconds (in-memory; a restart clears the counters).

## Bearer tokens (CLI and scripts)

Per-user tokens authenticate non-browser clients:

```bash
curl -H "Authorization: Bearer web_…" https://omp.example.com/api/sessions
```

- An admin creates tokens in the **Web users** panel of the Settings dialog, or directly via `POST /api/web-users/<username>/tokens` with `{ "name": "laptop-cli" }`.
- The **raw token is shown exactly once** (`web_` + 32 random bytes, base64url). Only its SHA-256 hash is stored, so it cannot be recovered later — copy it when it's displayed.
- Delete a token the same way (`DELETE /api/web-users/<username>/tokens/<name>` in the admin UI or API). Deleting a user revokes their tokens and sessions.

## Migrating from `OMP_WEB_PASSWORD`

`OMP_WEB_PASSWORD` still works, as HTTP Basic Auth with the fixed username `omp`:

```bash
curl -u 'omp:your-env-password' https://omp.example.com/api/sessions
```

While the variable is set, the implicit user `omp` is an admin and can also sign in at the `/login` page. This is a bridge — plan to move off it:

**First-admin setup:**

1. Start omp-web with `OMP_WEB_PASSWORD` set (or leave it set on an existing deployment).
2. Open the web UI, authenticate with the env password (`omp`), and open **Settings → Web users**.
3. Create your real admin user (role `admin`).
4. Log out, log back in as the new admin, and remove `OMP_WEB_PASSWORD` from the environment.

The env-backed `omp` identity exists only while the file store has no users *and* the variable is set, so once your first file-based user exists the env password is purely an extra Basic Auth credential you can drop. While it is set, unauthenticated API requests still receive a `WWW-Authenticate: Basic` challenge.

## The users file: `omp-web-users.yml`

Users live in `~/.omp/agent/omp-web-users.yml` (override the path with `OMP_WEB_USERS_FILE`, mainly for tests). The web UI writes this file; you normally don't edit it by hand, but the format is plain YAML, written atomically with mode `0600`:

```yaml
users:
  - username: alice            # [a-z0-9_-]{1,32}, unique, lowercase
    role: admin                # "admin" or "user"
    passwordHash: scrypt$16384$8$1$c2FsdA==$aGFzaA==...
    projects: "*"              # "*" = all projects, or a list of absolute roots:
    # projects:
    #   - /home/alex/work/project-a
    #   - /home/alex/work/project-b
    tokens:                    # CLI Bearer tokens (name + sha256 of the raw token)
      - name: laptop-cli
        tokenHash: 3f9c1b…     # sha256 hex — the raw token is never stored
        created: "2026-08-14T10:00:00.000Z"
  - username: bob
    role: user
    passwordHash: scrypt$16384$8$1$…
    projects:
      - /home/bob/demo
    tokens: []
sessions:
  secret: bXlTMi1ieXRl…       # 32-byte base64, auto-generated on first write
  ttlDays: 30                  # sliding session TTL in days (default 30)
```

Notes on the format:

- `passwordHash` is scrypt with fixed parameters N=16384, r=8, p=1, keylen=64, stored as `scrypt$N$r$p$saltB64$hashB64`. Generate hashes through the UI/API; the verifier only accepts this exact parameter set.
- `sessions.secret` is a 32-byte base64 value generated automatically on first write. Don't delete it on a live install.
- `sessions.ttlDays` sets the sliding cookie/session TTL for new logins.

## Roles and project visibility

Two roles exist:

- **admin** — sees every project, manages users and tokens, and can reach all configuration surfaces (models/providers, plugins, MCP, settings, project trust, updates, Git).
- **user** — sees only the projects listed in their `projects` field. Session lists, file browsing, the directory picker, worktree switching, and new-session creation are filtered to those roots. The provider login/API-key routes (`/api/auth/all-providers`, `/api/auth/api-key`, `/api/auth/login`, `/api/auth/logout`), plus `/api/plugins`, `/api/mcp`, `/api/project-trust`, `/api/settings`, `/api/updates`, `/api/models-config`, `/api/git`, and `/api/web-users`, return `403 Admin access required` for this role.

> **Visibility is UI-level filtering, not a security sandbox.**
>
> Project visibility hides projects from listings and blocks the obvious paths in the UI and API, but the filtering is per-request path-prefix matching, not an OS-level boundary. The agent process runs as one OS user with access to everything that user can read, so a determined `user`-role account driving the agent at a hidden path, or a future bug in one of the many routes, can reach outside the assigned projects.
>
> If two people must not be able to read each other's code, give each of them **their own omp-web instance running as a separate OS user** (separate sessions directory, separate users file), rather than relying on the `projects` filter.

## Terminals

The Terminal tab (see the README) requires authentication on non-loopback binds. Its host gate is satisfied by either `OMP_WEB_PASSWORD` **or** at least one stored web user — so a web-users deployment can enable `OMP_WEB_TERMINALS=1` without the env password. Remember the terminal is a full shell as the server's OS user, which is another reason per-user visibility is not isolation.

## Deployment notes

- Serve omp-web over HTTPS (a reverse proxy is the usual setup). The session cookie is marked `Secure` automatically on non-loopback hosts.
- Canonical production hostnames: **omp.joyai.dev** and **omp.joysort.cn**. `ompdev.joyai.dev` is a temporary/dev instance — don't use it as a stable URL.
- Remember the host allow-list: `OMP_WEB_ALLOWED_HOSTS` must include the proxy hostname(s), or requests are rejected with `400`/`403` before authentication is even attempted.
