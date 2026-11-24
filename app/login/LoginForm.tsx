"use client";

import { useRef, useState } from "react";

const inputStyle: React.CSSProperties = {
  width: "100%",
  height: 34,
  padding: "0 10px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
};

export function LoginForm({ next }: { next: string }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/web-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        // Full navigation so the new cookie applies to the page load itself.
        window.location.assign(next);
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "Login failed");
    } catch {
      setError("Network error");
    } finally {
      setPending(false);
    }
  }

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
        padding: 16,
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          width: "min(340px, 100%)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          padding: 24,
          border: "1px solid var(--border)",
          borderRadius: 10,
          background: "var(--bg-panel)",
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "var(--accent)",
          }}
        >
          omp-web
        </div>
        <h1 style={{ margin: 0, fontSize: 16, fontWeight: 650, color: "var(--text)" }}>
          Sign in
        </h1>
        <input
          aria-label="Username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="Username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          style={inputStyle}
        />
        <div style={{ position: "relative", width: "100%" }}>
          <input
            ref={passwordRef}
            aria-label="Password"
            type={passwordVisible ? "text" : "password"}
            autoComplete="current-password"
            placeholder="Password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            style={{ ...inputStyle, paddingRight: 34 }}
          />
          <button
            type="button"
            aria-label={passwordVisible ? "Hide password" : "Show password"}
            aria-pressed={passwordVisible}
            title={passwordVisible ? "Hide password" : "Show password"}
            onClick={() => {
              setPasswordVisible((v) => !v);
              passwordRef.current?.focus();
            }}
            style={{
              position: "absolute",
              right: 5,
              top: "50%",
              transform: "translateY(-50%)",
              width: 24,
              height: 24,
              padding: 0,
              border: "none",
              background: "transparent",
              color: "var(--text-dim)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {passwordVisible ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20C7 20 2.73 16.89 1 12a18.45 18.45 0 0 1 5.06-6.94" />
                <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c5 0 9.27 3.11 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                <path d="M14.12 14.12A3 3 0 0 1 9.88 9.88" />
                <path d="M1 1l22 22" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            )}
          </button>
        </div>
        {error && (
          <div role="alert" style={{ fontSize: 12, color: "var(--danger)", lineHeight: 1.4 }}>
            {error}
          </div>
        )}
        <button
          type="submit"
          disabled={pending || username.length === 0 || password.length === 0}
          style={{
            height: 34,
            border: "none",
            borderRadius: 6,
            background: pending || username.length === 0 || password.length === 0 ? "var(--bg-selected)" : "var(--accent)",
            color: pending || username.length === 0 || password.length === 0 ? "var(--text-dim)" : "#fff",
            fontSize: 13,
            fontWeight: 600,
            cursor: pending ? "wait" : "pointer",
          }}
        >
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
