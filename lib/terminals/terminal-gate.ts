import { isWebPasswordEnabled } from "../web-auth";

// Static membership tables — `Object.hasOwn` (not `in`) so env values like
// "constructor" can't hit Object.prototype keys.
const TRUE_VALUES: Record<string, true> = { "1": true, "true": true, "yes": true, "on": true };
const LOOPBACK_HOSTNAMES: Record<string, true> = {
  "127.0.0.1": true,
  "localhost": true,
  "::1": true,
  "[::1]": true,
};

/** Off unless explicitly enabled with `OMP_WEB_TERMINALS=1` (or true/yes/on). */
export function isTerminalFeatureEnabled(): boolean {
  const value = process.env.OMP_WEB_TERMINALS;
  return typeof value === "string" && Object.hasOwn(TRUE_VALUES, value.trim().toLowerCase());
}

/**
 * A terminal is a full shell. Refuse to serve it on a non-loopback bind
 * unless a web password is configured — mirrors the warning in
 * `bin/omp-web.js`, but blocking instead of advisory, because this feature
 * is strictly higher-risk than the rest of the API surface.
 */
export function isTerminalHostGateSatisfied(): boolean {
  const hostname = process.env.OMP_WEB_HOSTNAME ?? "127.0.0.1";
  if (Object.hasOwn(LOOPBACK_HOSTNAMES, hostname)) return true;
  return isWebPasswordEnabled();
}

export function isTerminalFeatureAvailable(): boolean {
  return isTerminalFeatureEnabled() && isTerminalHostGateSatisfied();
}
