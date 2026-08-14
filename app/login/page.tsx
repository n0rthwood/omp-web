import { LoginForm } from "./LoginForm";

/**
 * Only same-origin absolute paths are valid post-login redirect targets. A
 * leading "//host" (protocol-relative) or "/\host" (browsers normalize the
 * backslash) would send the user to an attacker host, so anything but a
 * single-slash path collapses to "/".
 */
export function sanitizeNextPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value;
}

export const metadata = {
  title: "Sign in · omp-web",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  return <LoginForm next={sanitizeNextPath(params?.next)} />;
}
