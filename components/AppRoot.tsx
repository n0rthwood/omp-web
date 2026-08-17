import { Suspense } from "react";
import { AppShell } from "@/components/AppShell";
import { I18nProvider } from "@/hooks/useI18n";

/**
 * The app's single client entry point, rendered identically from every
 * deeplink route (`/`, `/m/[[...segments]]`, `/p/[[...segments]]`). The
 * path itself carries no server-side meaning here — the client reads
 * `window.location` (see `lib/nav-url.ts`) and owns navigation from then on.
 */
export function AppRoot() {
  return (
    <Suspense>
      <I18nProvider>
        <AppShell />
      </I18nProvider>
    </Suspense>
  );
}
