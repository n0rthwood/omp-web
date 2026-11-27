import { getOmpSetting } from "./omp-setting-access";
import { getSettingsForCwd } from "./omp-runtime";
import { planModeStartupInfo, type WebPlanModeInfo } from "./plan-mode-web";

/**
 * Server-only: reads the process-wide omp Settings, so it must never be
 * imported from a client component (the React hook imports the pure
 * `planModeStartupInfo` from `plan-mode-web.ts` instead).
 *
 * Answers "which mode will a brand-new chat in `cwd` start in?" from the same
 * two settings the session host applies while creating the session
 * (`plan.defaultOnStartup`, gated by `plan.enabled`) — issue #161.
 */
export async function getPlanModeStartupInfo(cwd?: string): Promise<WebPlanModeInfo> {
  const settings = await getSettingsForCwd(cwd);
  const defaultOnStartup = getOmpSetting<boolean>(settings, "plan.defaultOnStartup") === true;
  // A missing `plan.enabled` means the schema default (enabled), mirroring
  // `configuredAvailability` in plan-mode-web.ts.
  const configured = getOmpSetting<unknown>(settings, "plan.enabled");
  const available = configured === undefined ? true : Boolean(configured);
  return planModeStartupInfo(defaultOnStartup, available);
}