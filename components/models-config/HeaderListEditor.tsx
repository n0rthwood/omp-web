"use client";

import { useRef, useState } from "react";
import { serializeHeaderRows, updateHeaderRow, type HeaderRow } from "../models-config-helpers";
import { inputStyle } from "./ui";

/** Editable key/value request-header list for a provider or model. */
export function HeaderListEditor({ headers, onChange }: {
  headers: Record<string, string> | undefined;
  onChange: (headers: Record<string, string> | undefined) => void;
}) {
  const [rows, setRows] = useState<HeaderRow[]>(() => Object.entries(headers ?? {}).map(
    ([name, value], id) => ({ id, name, value }),
  ));
  const nextRowIdRef = useRef(rows.length);

  const applyRows = (next: HeaderRow[]): void => {
    setRows(next);
    onChange(serializeHeaderRows(next));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {rows.map((row) => (
        <div key={row.id} style={{ display: "flex", gap: 6 }}>
          <input value={row.name} onChange={(e) => applyRows(updateHeaderRow(rows, row.id, { name: e.target.value }))}
            placeholder="Header-Name" style={{ ...inputStyle, fontFamily: "var(--font-mono)", flex: 1 }} />
          <input value={row.value} onChange={(e) => applyRows(updateHeaderRow(rows, row.id, { value: e.target.value }))}
            placeholder="value" style={{ ...inputStyle, fontFamily: "var(--font-mono)", flex: 1 }} />
          <button type="button" onClick={() => applyRows(rows.filter((entry) => entry.id !== row.id))}
            style={{ padding: "6px 9px", background: "none", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 4, color: "#ef4444", cursor: "pointer", fontSize: 11, lineHeight: 1 }}>✕</button>
        </div>
      ))}
      <button type="button" onClick={() => setRows((current) => [...current, { id: nextRowIdRef.current++, name: "", value: "" }])}
        style={{ padding: "5px 9px", background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", cursor: "pointer", fontSize: 11, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, alignSelf: "flex-start" }}>
        + Add header
      </button>
    </div>
  );
}