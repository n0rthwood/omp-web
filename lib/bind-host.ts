// Static membership table — `Object.hasOwn` (not `in`) so env values like
// "constructor" can't hit Object.prototype keys.
const LOOPBACK_HOSTNAMES: Record<string, true> = {
  "127.0.0.1": true,
  "localhost": true,
  "::1": true,
  "[::1]": true,
};

/**
 * Whether this server is bound to loopback, i.e. only a process on this host
 * can reach it. The bind address, not the peer address: behind cloudflared or
 * Caddy every public request also arrives from 127.0.0.1, so a peer check
 * would call the whole internet local.
 *
 * Higher-risk features (terminals, fleet configuration) use this to decide
 * whether they may run without authentication in front of them.
 */
export function isLoopbackBind(): boolean {
  const hostname = process.env.OMP_WEB_HOSTNAME ?? "127.0.0.1";
  return Object.hasOwn(LOOPBACK_HOSTNAMES, hostname);
}
