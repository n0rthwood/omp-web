import { AppRoot } from "@/components/AppRoot";

// `/m/<machineId>[/p/<project>[/s/<session>]]` — the segments are
// intentionally ignored server-side; the client parses the raw
// `window.location.pathname` itself (see `lib/nav-url.ts`) and owns
// navigation from then on. This route only needs to exist so a full page
// load or reload on the path renders the app instead of 404ing.
export default function MachineDeeplink() {
  return <AppRoot />;
}
