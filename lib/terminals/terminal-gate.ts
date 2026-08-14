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
 *
 * `OMP_WEB_TERMINALS_ALLOW_UNAUTHENTICATED` is the deliberate way out, for a
 * bind that is trusted but not loopback (LAN, ZeroTier, VPN-only host). It is
 * named to read as a decision in a process list or a PM2 dump, because the
 * alternative operators reach for — declaring `OMP_WEB_HOSTNAME=127.0.0.1`
 * while binding `0.0.0.0` — leaves this guard silently disabled if the host is
 * ever exposed. It does not disable authentication; it only stops the *terminal
 * feature* from requiring it.
 */
export function isTerminalHostGateSatisfied(): boolean {
  const hostname = process.env.OMP_WEB_HOSTNAME ?? "127.0.0.1";
  if (Object.hasOwn(LOOPBACK_HOSTNAMES, hostname)) return true;
  if (isWebPasswordEnabled()) return true;
  return isUnauthenticatedTerminalsAllowed();
}

/** True only when the operator set the opt-out; never implied by anything else. */
export function isUnauthenticatedTerminalsAllowed(): boolean {
  const value = process.env.OMP_WEB_TERMINALS_ALLOW_UNAUTHENTICATED;
  return typeof value === "string" && Object.hasOwn(TRUE_VALUES, value.trim().toLowerCase());
}

export function isTerminalFeatureAvailable(): boolean {
  return isTerminalFeatureEnabled() && isTerminalHostGateSatisfied();
}

/**
 * Set when the terminal feature is reachable with no authentication at all.
 * Callers use it to warn; nothing branches on it.
 */
export function isUnauthenticatedTerminalExposure(): boolean {
  return isTerminalFeatureAvailable() && !isWebPasswordEnabled();
}
