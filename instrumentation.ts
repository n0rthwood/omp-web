import type { configureHttpDispatcher as ConfigureHttpDispatcher } from "@/lib/http-dispatcher";
import type { isUnauthenticatedTerminalExposure as IsUnauthenticatedTerminalExposure } from "@/lib/terminals/terminal-gate";

type DispatcherModule = { configureHttpDispatcher: typeof ConfigureHttpDispatcher };
type TerminalGateModule = { isUnauthenticatedTerminalExposure: typeof IsUnauthenticatedTerminalExposure };

/**
 * Hides the specifier from webpack's static import graph. Next compiles this
 * file for both the nodejs and edge runtimes (the instrumentation hook
 * contract supports both — see the `NEXT_RUNTIME` guard below), but every
 * module loaded this way is nodejs-only: it reaches `node:crypto`/`node:fs`
 * and `@oh-my-pi/pi-coding-agent`'s raw TypeScript sources, none of which
 * the edge bundle can resolve or execute. A static top-level `import` would
 * still be traced (and fail to build) for the edge bundle even though
 * `register()` never calls into it there. Node 22 and Bun can load these
 * local TypeScript modules directly.
 */
const importRuntimeModule = Function("specifier", "return import(specifier)") as <T>(
  specifier: string,
) => Promise<T>;

function runtimeModuleUrl(relativePath: string): string {
  return `file://${encodeURI(process.cwd())}/${relativePath}`;
}

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Before the Bun bail-out below: this warning must print on the runtime that
  // actually serves traffic here, which is Bun via `next start`.
  const { isUnauthenticatedTerminalExposure } = await importRuntimeModule<TerminalGateModule>(
    runtimeModuleUrl("lib/terminals/terminal-gate.ts"),
  );
  if (isUnauthenticatedTerminalExposure()) {
    console.warn(
      "\n⚠  omp-web: the Terminal tab is enabled with NO authentication.\n"
      + `   Bound to ${process.env.OMP_WEB_HOSTNAME ?? "127.0.0.1"}; anyone who can reach this\n`
      + "   server gets an interactive shell as this user. Set OMP_WEB_PASSWORD, or bind to\n"
      + "   loopback, unless every network that reaches this port is trusted.\n",
    );
  }

  if (typeof process.versions.bun === "string") return;

  // Keep the Node-only undici graph out of Next's browser/edge instrumentation
  // bundles.
  const { configureHttpDispatcher } = await importRuntimeModule<DispatcherModule>(
    runtimeModuleUrl("lib/http-dispatcher.ts"),
  );
  await configureHttpDispatcher();
}
