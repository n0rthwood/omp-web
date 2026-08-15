/**
 * Client seam for the fleet gateway URL shape.
 *
 * local:  /api/sessions
 * remote: /api/machines/<machineId>/api/sessions
 *
 * Every client-side API URL must go through `apiPath()` so a single module
 * decides whether a request hits the local omp-web or is proxied to a remote
 * machine. Likewise, localStorage keys that hold absolute paths or session ids
 * must be namespaced per machine via `machineStorageKey()`.
 *
 * Pure module: no React, no fs. The current machine id is module-level state,
 * set synchronously by the MachineProvider before any child effect runs.
 */

export const LOCAL_MACHINE_ID = "local";

let currentMachineId: string = LOCAL_MACHINE_ID;

export function setCurrentMachineId(id: string): void {
  currentMachineId = id === "" ? LOCAL_MACHINE_ID : id;
}

export function getCurrentMachineId(): string {
  return currentMachineId;
}

/**
 * "/api/x?y" -> "/api/machines/<id>/api/x?y" for a remote machine.
 * Unchanged for the local machine and for any string that does not start
 * with "/api/". The machine id is encodeURIComponent'd; the query string
 * is preserved verbatim.
 */
export function apiPath(path: string, machineId?: string): string {
  const id = machineId ?? currentMachineId;
  if (id === LOCAL_MACHINE_ID) return path;
  if (!path.startsWith("/api/")) return path;
  return `/api/machines/${encodeURIComponent(id)}${path}`;
}

/**
 * localStorage/sessionStorage key namespacing: "k" -> "k" locally,
 * "m:<id>:k" remote. The id is encodeURIComponent'd so a slug can never
 * inject a ":" separator.
 */
export function machineStorageKey(key: string, machineId?: string): string {
  const id = machineId ?? currentMachineId;
  if (id === LOCAL_MACHINE_ID) return key;
  return `m:${encodeURIComponent(id)}:${key}`;
}
