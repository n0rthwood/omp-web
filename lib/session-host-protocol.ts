/**
 * Web-owned frames on the session-host wire (issue #94, frozen contract §3/§4).
 *
 * The host↔web channel is NDJSON over a Unix socket carrying the SDK rpc
 * protocol v2 verbatim. These are the only frames the web tier adds on top;
 * everything else (commands, responses, session events, extension UI,
 * subagents) is SDK wire shape passed through untouched. Shared by
 * `lib/rpc-manager.ts` (web proxy) and `ops/session-host/*` (host shell).
 */

/** First frame a host emits on every attach, before the SDK `ready` frame. */
export interface HostHelloFrame {
	type: "host_hello";
	protocol: "omp-web-host/1";
	sessionId: string;
	/** Empty string while the session has no on-disk journal yet. */
	sessionFile: string;
	cwd: string;
}

/**
 * Host-pushed live-session snapshot backing the SYNC `getRpcSessionInfos()`
 * export. Fields are the precomputed pieces of the SessionInfo computation the
 * old in-process wrapper did from its live SessionManager; `isRunning` is the
 * host's activity view at emit time. Emitted on prompt admission, agent_end,
 * prompt_result, session_renamed, session_settled, and attach (contract §4).
 */
export interface HostSessionInfoFrame {
	type: "session_info";
	sessionId: string;
	sessionFile: string;
	cwd: string;
	name?: string;
	/** Journal header timestamp when present, else the first entry's. */
	created: string;
	/** Newest user/assistant message activity, ISO string. */
	modified: string;
	messageCount: number;
	firstMessage: string;
	/** False until the journal exists on disk (transient session). */
	persisted: boolean;
	/** Journal tail status; the web overrides it to "pending" while running. */
	status: "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";
	/** True when the host observed an active run/queue/background work at emit time. */
	isRunning: boolean;
	/** Startup persisted an explicit model default; web invalidates its models cache. */
	modelDefaultChanged?: boolean;
}

/**
 * Creation options a freshly spawned host applies while replicating the old
 * startRpcSession preamble (rotation, initial model scope, tool allow-list).
 * Passed on the host command line; an ATTACH to an already-live host ignores
 * them — the session keeps the identity it was created with.
 */
export interface HostStartOptions {
	/** Session id the browser knows; used as the transient unit/socket name. */
	sessionId: string;
	/** Absolute journal path, or "" to create a new session in `cwd`. */
	sessionFile: string;
	/** Required when sessionFile is "". */
	cwd?: string;
	/** Requested active tools; [] means "all off" (forced empty system prompt). */
	toolNames?: string[];
	initialModel?: { provider: string; modelId: string };
	thinkingLevel?: string;
}

/** Per-session socket directory shared by session hosts and the terminal daemon. */
export const OMP_WEB_HOST_RUN_SUBDIR = ["run", "omp-web-hosts"] as const;

export function isHostHelloFrame(value: unknown): value is HostHelloFrame {
	if (!value || typeof value !== "object") return false;
	if (!("type" in value) || value.type !== "host_hello") return false;
	if (!("protocol" in value) || value.protocol !== "omp-web-host/1") return false;
	return "sessionId" in value && typeof value.sessionId === "string" &&
		"cwd" in value && typeof value.cwd === "string" &&
		"sessionFile" in value && typeof value.sessionFile === "string";
}

export function isHostSessionInfoFrame(value: unknown): value is HostSessionInfoFrame {
	if (!value || typeof value !== "object") return false;
	if (!("type" in value) || value.type !== "session_info") return false;
	return "sessionId" in value && typeof value.sessionId === "string" &&
		"sessionFile" in value && typeof value.sessionFile === "string" &&
		"cwd" in value && typeof value.cwd === "string" &&
		"messageCount" in value && typeof value.messageCount === "number" &&
		"persisted" in value && typeof value.persisted === "boolean";
}

/**
 * Host-written `<socketKey>.info` sidecar beside the socket (issue #94 defect
 * 2). Lets a restarted web process discover surviving hosts by REAL session
 * id even when the socket is keyed by a temporary `__new__` id. Written
 * atomically only while the host would emit session_info; removed when the
 * frame is suppressed again and at host exit. `pid` is checked with kill(0)
 * before an entry is trusted — the SDK journal lease is an abstract-socket
 * flock that leaves no usable filesystem liveness signal on Linux.
 */
export interface HostDiscoverySidecar {
	pid: number;
	socketKey: string;
	info: HostSessionInfoFrame;
}

export function isHostDiscoverySidecar(value: unknown): value is HostDiscoverySidecar {
	if (!value || typeof value !== "object") return false;
	return "pid" in value && typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0 &&
		"socketKey" in value && typeof value.socketKey === "string" && value.socketKey.length > 0 &&
		"info" in value && isHostSessionInfoFrame(value.info);
}
