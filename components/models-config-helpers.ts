import { apiPath } from "@/lib/api-path";

export interface CompatEntry {
  compat?: Record<string, unknown>;
}

export interface HeaderRow {
  id: number;
  name: string;
  value: string;
}

export function setCompatBool<T extends CompatEntry>(entry: T, key: string, value: boolean): T {
  return {
    ...entry,
    compat: { ...(entry.compat ?? {}), [key]: value },
  };
}

export function updateHeaderRow(
  rows: readonly HeaderRow[],
  id: number,
  changes: Partial<Pick<HeaderRow, "name" | "value">>,
): HeaderRow[] {
  return rows.map((row) => row.id === id ? { ...row, ...changes } : row);
}

export function serializeHeaderRows(rows: readonly HeaderRow[]): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name) headers[name] = row.value;
  }
  return Object.keys(headers).length ? headers : undefined;
}

export async function refreshProviderModels(
  providerName: string,
  onModelsChanged?: () => void,
  fetchImpl: typeof fetch = fetch,
): Promise<{ discoveryStatus?: string; warning?: string }> {
  try {
    const response = await fetchImpl(apiPath("/api/models-config/refresh-provider"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerName }),
    });
    const result = await response.json().catch(() => null) as {
      success?: boolean;
      discoveryStatus?: string;
      warning?: string;
      error?: string;
    } | null;
    if (!response.ok || !result?.success) {
      throw new Error(result?.error || `HTTP ${response.status}`);
    }
    return result;
  } finally {
    // A failed or interrupted request may have changed the server registry.
    onModelsChanged?.();
  }
}
