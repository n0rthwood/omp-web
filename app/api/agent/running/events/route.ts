import { getRunningRpcSessionIds, subscribeRunningSessions } from "@/lib/rpc-manager";
import { refreshHostDiscovery } from "@/lib/session-host-transport";
import { getWebUserOrSynthetic } from "@/lib/web-auth-context";
import { filterVisibleSessionIds } from "@/lib/web-session-guard";

export const dynamic = "force-dynamic";

// GET /api/agent/running/events - SSE stream of the set of currently-running
// session ids. Pushes an update whenever any session starts or stops working,
// so the sidebar never has to poll. Ids are filtered to the caller's visible
// sessions (issue #7) — hidden live sessions are never discoverable.
export async function GET(req: Request) {
  const user = await getWebUserOrSynthetic(req);

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const encode = (data: unknown) => {
        const text = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(text));
      };

      const emitVisible = async (ids: string[]) => {
        try {
          const visible = user ? await filterVisibleSessionIds(user, ids) : [];
          encode({ type: "running", runningSessionIds: visible });
        } catch {
          // controller already closed
        }
      };

      // Subscribe BEFORE taking the initial snapshot so no state change can slip
      // through the gap between snapshot and subscription.
      const unsubscribe = subscribeRunningSessions((ids) => {
        void emitVisible(ids);
      });

      // Initial snapshot so the client renders the correct state immediately.
      // (A duplicate frame here is harmless: the client just sets the same set.)
      void (async () => {
        // Defect 2: pick up hosts that survived a web restart before the
        // first snapshot (non-attaching — the idle reaper must stay intact).
        await refreshHostDiscovery();
        await emitVisible(getRunningRpcSessionIds());
      })();

      // Heartbeat to keep the connection alive through proxies/timeouts.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          // controller already closed
        }
        // Re-scan sidecars each heartbeat: discovered hosts emit no local
        // running-change events, so refresh + re-emit keeps the set honest
        // after a web restart without attaching (idle reaper unaffected).
        void (async () => {
          await refreshHostDiscovery();
          await emitVisible(getRunningRpcSessionIds());
        })();
      }, 30_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      };

      req.signal?.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
