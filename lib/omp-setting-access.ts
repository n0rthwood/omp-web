import "@oh-my-pi/pi-coding-agent/config/all-settings";
import { lookup, type AnySetting } from "@oh-my-pi/pi-coding-agent/config/registry";
import type { Settings } from "@oh-my-pi/pi-coding-agent";

export function ompSetting(path: string): AnySetting {
  const setting = lookup(path);
  if (!setting) throw new Error(`Unknown omp setting: ${path}`);
  return setting;
}

export function getOmpSetting<T = unknown>(settings: Settings, path: string): T {
  return ompSetting(path).get(settings) as T;
}

export function setOmpSetting(settings: Settings, path: string, value: unknown): void {
  ompSetting(path).set(settings, value as never);
}

export function overrideOmpSetting(settings: Settings, path: string, value: unknown): void {
  ompSetting(path).override(settings, value as never);
}
