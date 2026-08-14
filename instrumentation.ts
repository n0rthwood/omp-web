import { isUnauthenticatedTerminalExposure } from "@/lib/terminals/terminal-gate";
import type { configureHttpDispatcher as ConfigureHttpDispatcher } from "@/lib/http-dispatcher";

type DispatcherModule = { configureHttpDispatcher: typeof ConfigureHttpDispatcher };

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Before the Bun bail-out below: this warning must print on the runtime that
  // actually serves traffic here, which is Bun via `next start`.
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
  // bundles. Node 22 can load this local TypeScript module directly.
  const importRuntimeModule = Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<DispatcherModule>;
  const moduleUrl = `file://${encodeURI(process.cwd())}/lib/http-dispatcher.ts`;
  const { configureHttpDispatcher } = await importRuntimeModule(moduleUrl);
  await configureHttpDispatcher();
}
