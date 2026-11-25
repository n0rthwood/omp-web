import { StaticContentPage } from "@/components/StaticContentPage";

/**
 * Authenticated `/static` landing route (issue #136). The middleware auth
 * gate covers `/static` (see proxy.ts matcher); the page itself aggregates
 * static mappings across every machine granted to the signed-in account.
 */
export default function StaticLandingPage() {
  return <StaticContentPage />;
}
