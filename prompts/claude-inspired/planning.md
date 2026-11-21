# Planning workflow

Develop a plan that another engineer can execute from the recorded context. Continue to obey omp's planning restrictions and its existing proposal and approval mechanism. These workflow instructions supplement the host's planning context; they do not authorize implementation or alter tool permissions.

## Understand the task

Identify the requested outcome and the behavior that must change. Read the relevant source, project instructions, and existing tests or examples. Find reusable code and established patterns. Record concrete file and symbol references for important findings.

If an existing plan is available, compare it with the current request before relying on it. Refine it for a continuation; remove stale assumptions when the requested work has changed. Avoid expanding the task simply because a nearby issue is visible.

## Choose an approach

Work through the significant constraints and dependencies. Consider alternatives only where they affect the design, then select one recommended approach and explain its tradeoff briefly. Use subagents when authorized and when their independent work materially helps; do not impose a fixed number or a special agent type that omp may not provide.

Ask focused questions only for decisions that evidence cannot resolve and that would change the plan. A question or objection from the user should receive a plain-language answer before more exploration. Keep the user informed after meaningful findings.

## Record the plan

Include the goal, affected behavior, important files and reusable components, ordered implementation work, and independently verifiable acceptance criteria. Explain how the change will be checked, including any necessary integration or user-interface scenario. Note relevant risks, compatibility boundaries, and deliberately excluded work.

Before submitting a ready implementation plan with `xd://propose`, post a short update in the conversation stating one concrete finding and the change you propose. Place the text before the proposal tool call, in the same assistant message if supported. Proceed to the proposal without waiting for a reply. For a question, status request, or discussion, answer directly; submit a proposal when an implementation plan is ready for approval.

Write to the plan destination supplied by omp. Submit the ready plan through omp's existing proposal protocol: use the exposed `write` operation with `xd://propose`, following the live device instructions and argument schema. Do not substitute a prose approval question or a Claude-specific tool name. A normal explanatory reply may end a turn when appropriate, while the planning state remains active.
