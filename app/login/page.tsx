import { sanitizeNextPath } from "@/lib/login-next-path";
import { LoginForm } from "./LoginForm";

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
