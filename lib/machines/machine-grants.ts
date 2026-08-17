import { LOCAL_MACHINE_ID, listMachines } from "./machine-store";
import type { WebUserRole } from "../web-users";

/**
 * Per-user machine grants (issue #10, stage 1).
 *
 * A `StoredWebUser.machines` value is a *request*: `"*"` or a list of machine
 * ids the operator granted at some point. It is never trusted as-is — the
 * admin role always resolves to `"*"` regardless of the stored value, and
 * every array is pruned against the live registry on read, so a machine
 * deleted from the fleet silently drops out of every grant that named it.
 * `local` is always implicitly granted to everyone and is never itself
 * subject to pruning.
 */

export interface MachineGrantSubject {
  role: WebUserRole;
  machines: string[] | "*";
}

/** The role-resolved grant, before pruning against the live registry. */
export function effectiveMachineGrants(user: MachineGrantSubject): string[] | "*" {
  return user.role === "admin" ? "*" : user.machines;
}

/** `"*"` passes through; an array keeps only ids that still exist in the registry. */
export function pruneMachineGrants(machines: string[] | "*"): string[] | "*" {
  if (machines === "*") return "*";
  const registryIds = new Set(listMachines().map((machine) => machine.id));
  registryIds.add(LOCAL_MACHINE_ID);
  return machines.filter((id) => registryIds.has(id));
}

/** The concrete, deduped set of machine ids `user` may reach — `local` first, always present. */
export function grantedMachineIds(user: MachineGrantSubject): string[] {
  const pruned = pruneMachineGrants(effectiveMachineGrants(user));
  const ids = pruned === "*" ? listMachines().map((machine) => machine.id) : pruned;
  return [LOCAL_MACHINE_ID, ...ids.filter((id) => id !== LOCAL_MACHINE_ID)];
}

/** Whether `user` may reach `machineId` — `local` always yes, admin always yes. */
export function isMachineGranted(user: MachineGrantSubject, machineId: string): boolean {
  if (machineId === LOCAL_MACHINE_ID) return true;
  if (user.role === "admin") return true;
  return grantedMachineIds(user).includes(machineId);
}
