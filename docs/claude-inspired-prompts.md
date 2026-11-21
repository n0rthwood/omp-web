# Claude-inspired omp workflow

The optional **Claude-inspired omp workflow** preset contains original omp-web instructions informed by a review of Claude Code 2.1.330 and Anthropic's public customization model. These files are not Claude's verbatim system prompt and do not imply Anthropic endorsement. They use omp's identity, tools, plan proposal device, and host permission model.

## Use the preset

Open **Settings → Prompts → New conversation defaults**, choose **Review this preset**, review the staged sources, and select **Save for new conversations**. Project values override the same resources in global defaults; global means the selected machine's omp account. Existing conversations keep their pinned managed sources, including after a host restart. The System button opens the current conversation's inspector for administrators; other readers retain their existing read-only System view.

Use **Injection controls** in the same workspace to change native injection settings. These controls use the same API, setting keys and change notifications as #116's conversation controls. They display native setting timing separately from managed prompt saves. The startup planning switch controls automatic entry into plan mode, not the rules of an already active plan.

The editor preserves source text, including literal template markers and instruction XML. Markdown presentation and example template rendering are separate views. Uniform line endings and the original BOM are preserved; editing a mixed-line-ending source uses CRLF if it contained CRLF, otherwise its original CR or LF style. An unchanged source is not rewritten.

## Packaged sources

| File | Destination | Purpose |
| --- | --- | --- |
| `prompts/claude-inspired/working-style.md` | Additional instructions | Evidence-based investigation, focused changes, useful progress, tool discipline and honest completion reports. |
| `prompts/claude-inspired/planning.md` | Planning additions | Research the request, choose an approach, review it, record a verifiable plan and use omp's existing approval protocol. |
| `prompts/claude-inspired/after-plan-approval.md` | After plan approval | Execute agreed work, preserve unrelated changes, report progress and verify the outcome. |

The preset does not change the base-template setting. With the default configuration, the base stays inherited from the SDK, including its tool inventory, skills, rules and environment. An existing owned base is preserved; it remains an advanced customization, separate from this preset.

Preset selection stages editable Markdown; saving and scope resolution follow the Prompts workspace's normal controls. Selecting the preset must not silently turn on plan mode, disable existing injections, or change a recorded conversation's managed profile. The sources can be edited after selection. Package upgrades must not replace user-edited managed content.

## Review findings

The installed native executable was `/home/joysort/.local/share/claude/versions/2.1.330`. Read-only inspection of its embedded JavaScript and text found the following structures. Byte offsets identify this exact binary; names and offsets are evidence, not supported APIs.

| Structure | Installed evidence | Adaptation |
| --- | --- | --- |
| Shared coding base | Task behavior around byte 324257684 | Keep a common omp base for both planning and execution. |
| Full and sparse planning reminders | Selector around 327585803, full renderer at 327594063 | Treat planning as a runtime overlay; preserve omp's dynamic plan and tool information. |
| Configurable workflow body | Option description around 313233128; hidden CLI flag definition at 332557771 | The installed Claude version supports a custom workflow body while retaining its read-only preamble and approval footer. omp supplements its native planning context through supported hooks. |
| Re-entry reminder | Branch around 327641227 | Compare an existing plan with the current request before continuing it. |
| Mode-exit reminder | Branch around 327614054 | Put post-approval guidance into the actual transition, including same-turn continuation. |
| Other injected context | Registry around 312788637 | Keep project, hook, skill, memory and task sources distinct from the base prompt. |

The binary also contains Claude-specific agent types, tool names, permission policies and a planning footer that constrains how turns end. Those details were not imported. In particular, omp-web #114 allows direct prose answers and progress in plan mode. Requiring every planning turn to end with a clarification or approval tool would regress that behavior.

No model request or production setting change was made for this review. The binary inspection confirms embedded branches exist; it does not establish that every model, provider or surface selects the same branch.

## Official source comparison

- [CLI reference](https://code.claude.com/docs/en/cli-reference): replacement and append options are distinct; prompt snapshots are reused on resume until compaction or a new conversation. omp uses explicit new-conversation managed defaults without adopting Claude's compaction refresh policy.
- [Modifying system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts): replacing the base does not remove conversation reminders. Application instructions can arrive through project context and hooks; context the application replaces has separate controls. The omp inspector preserves this distinction.
- [Hooks reference](https://code.claude.com/docs/en/hooks): hook context enters at its lifecycle point. The hook browser shows source ownership. Claude documents broad hook disable/removal controls; omp retains its existing finer source-to-setting controls.
- [Output styles](https://code.claude.com/docs/en/output-styles): reusable behavior and tone instructions are distinct from permissions and can preserve engineering guidance. The named omp preset similarly preserves SDK tool guidance.
- [Permission modes](https://code.claude.com/docs/en/permission-modes#analyze-before-you-edit-with-plan-mode): planning, approval and mode transitions belong to the runtime. omp keeps its own guards and approval flow.

## Injection controls

Settings and the conversation cards are two entry points to the same source-to-setting mapping, scope resolver and mutation API. Do not introduce a second stored switch for the same native source. A settings row must show whether it changes the current mode, future startup, an optional supplement, or an SDK feature.

Native enum/list settings retain their actual semantics; a rule-specific toggle must not erase other disabled rules. Sources without a supported switch remain inspectable with an explanation. A switch must not merely hide a card while leaving an injection active.

Managed source changes follow pinned-profile timing for new conversations. Native SDK settings display their actual application timing. Previously injected transcript entries remain visible after a source is disabled; toggling it does not erase historical context or change host permissions.

Selecting this preset does not automatically suppress an omp reminder merely because Claude uses a different one. If a real duplicate is identified, link to its existing setting and let the user choose.
