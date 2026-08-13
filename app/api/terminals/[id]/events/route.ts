import { isApiRequestAllowed } from "@/lib/request-security";
import { isTerminalFeatureAvailable } from "@/lib/terminals/terminal-gate";
import { getTerminalInfo, subscribeTerminal } from "@/lib/terminals/terminal-service";

export const dynamic = "force-dynamic";

// GET /api/terminals/[id]/events - SSE stream of terminal output
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isApiRequestAllowed(req)) {
    return new Response("Untrusted API request", { status: 403 });
  }
  if (!isTerminalFeatureAvailable()) {
    return new Response("Not found", { status: 404 });
  }

  const { id } = await params;
  if (!getTerminalInfo(id)) {
    return new Response("Not found", { status: 404 });
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const encode = (data: unknown) => {
        const text = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(text));
      };

      // Send initial connected event
      encode({ type: "connected", id });

      // Heartbeat every 30s to prevent server/proxy timeout (Next.js default ~120-150s)
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          // controller already closed
        }
      }, 30_000);

      let closed = false;
      const closeStream = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // controller already closed
        }
      };

      // subscribeTerminal itself delivers the replay buffer (and the exit
      // state, if already exited) synchronously to the listener before
      // returning — do NOT re-send the buffer here, that would double the
      // scrollback on every connect.
      const unsubscribe = subscribeTerminal(id, (event) => {
        encode(event);
        if (event.type === "exit") {
          // The client treats `exit` as terminal and stops reconnecting;
          // flush the frame and close the stream.
          closeStream();
        }
      });

      if (!unsubscribe) {
        // Terminal vanished between the existence check and subscribe —
        // tell the client to stop reconnecting and close.
        encode({ type: "exit", exitCode: null });
        closeStream();
        return;
      }

      // Do NOT kill the pty on SSE disconnect — only explicit DELETE does.
      // A disconnect is a normal page reload/backgrounding event; the shell
      // must keep running so scrollback + a running command survive it.
      // Cleanup when client disconnects via abort signal.
      req.signal?.addEventListener("abort", () => {
        unsubscribe();
        closeStream();
      });
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
