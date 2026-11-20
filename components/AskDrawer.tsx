"use client";

import { AskDialogContent, type AskDialogResponse, type SidePanelDialogRequest } from "./AskDialogContent";
import { PlanReviewContent } from "./PlanReviewContent";

export function AskDrawer({ request, onRespond, open, onClose }: {
  request: SidePanelDialogRequest;
  onRespond: (response: AskDialogResponse) => void;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <div
      data-testid={request.method === "plan_review" ? "plan-drawer" : "ask-drawer"}
      hidden={!open}
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 400,
        display: open ? "flex" : "none",
        flexDirection: "column",
        maxHeight: "70dvh",
        height: "auto",
        overflow: "hidden",
        borderTop: "1px solid var(--border)",
        borderRadius: "12px 12px 0 0",
        background: "var(--bg)",
        boxShadow: "0 -12px 36px rgba(0,0,0,0.22)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      {request.method === "plan_review" ? (
        <PlanReviewContent request={request} onRespond={onRespond} variant="drawer" onClose={onClose} />
      ) : (
        <AskDialogContent request={request} onRespond={onRespond} variant="drawer" onClose={onClose} />
      )}
    </div>
  );
}
