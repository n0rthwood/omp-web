import { LOCAL_MACHINE_ID } from "./api-path";

export interface InitialNavigation {
  requestedCwd: string | null;
  sessionId: string | null;
  /** Fleet machine the URL selected (`?machine=`); "local" when absent. */
  machineId: string;
}

export function getInitialNavigation(searchParams: Pick<URLSearchParams, "get">): InitialNavigation {
  const requestedCwd = searchParams.get("cwd")?.trim() || null;

  return {
    requestedCwd,
    sessionId: requestedCwd ? null : searchParams.get("session"),
    machineId: searchParams.get("machine")?.trim() || LOCAL_MACHINE_ID,
  };
}
