import { isLoopbackBind } from "../bind-host";
import { authEnabled } from "../web-users";

/**
 * Whether this instance may have machines added or edited.
 *
 * Registering a machine stores a credential for *another* host, so an open
 * gateway on a reachable interface hands out lateral access to everything in
 * the registry. `authEnabled()` is false when there is neither an
 * `OMP_WEB_PASSWORD` nor a stored user, and in that state every caller
 * resolves to the synthetic anonymous **admin** — the admin-only route guard
 * stops nobody. Mirrors `isTerminalHostGateSatisfied()`: a loopback bind is
 * trusted, anything wider needs real authentication.
 *
 * Only the write paths are gated. Listing the registry and proxying to an
 * already-approved machine keep working, so flipping the bind address does not
 * silently break a running fleet — it stops it from growing.
 */
export function isFleetConfigurationAllowed(): boolean {
  return isLoopbackBind() || authEnabled();
}

export const FLEET_CONFIGURATION_DENIED_MESSAGE =
  "Set OMP_WEB_PASSWORD or create a web user before adding machines: this instance is reachable "
  + "beyond loopback with no authentication, and the machine registry holds credentials for other hosts.";
