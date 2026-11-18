/**
 * UDS transport for the session-host proxy (issue #94, contract §3).
 *
 * One Bun Unix-socket connection per attached session host. RpcClient consumes
 * this as an `RpcAgentProcess`:
 * - stdin.write NEVER throws and never returns a rejecting promise (a throw
 *   would make RpcClient#writeFrame stop the client). There is deliberately NO
 *   `flush` member: RpcClient checks `"flush" in stdin` and would call it.
 * - Outbound bytes are queued: Bun UDS socket.write is PARTIAL and DROPS
 *   unaccepted bytes (probe: an 8 MiB write accepted 219264 bytes; an immediate
 *   second write accepted 0). Write what fits, buffer the remainder, resume on
 *   `drain`.
 * - stdout stays open for the host's lifetime; UDS close resolves `exited`,
 *   which the wrapper treats as host death (detach + registry drop).
 * - kill() is a gated no-op unless allowTerminate() allows it: web-process
 *   exit, SSE disconnect, and RpcClient.stop() during detach MUST NOT kill the
 *   host. Explicit termination goes through requestTerminate (stop the
 *   transient systemd unit); the host owns its socket and SDK teardown.
 */

import type { Socket } from "bun";
import type { RpcAgentProcess } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import {
	OMP_WEB_HOST_RUN_SUBDIR,
	isHostDiscoverySidecar,
	isHostHelloFrame,
	type HostDiscoverySidecar,
	type HostHelloFrame,
	type HostSessionInfoFrame,
} from "./session-host-protocol";

/** Shared socket directory (`~/.omp/run/omp-web-hosts`), override for tests. */
export function hostRunDir(): string {
	return process.env.OMP_WEB_HOST_RUN_DIR ?? join(homedir(), ".omp", ...OMP_WEB_HOST_RUN_SUBDIR);
}

export function hostSocketPath(sessionId: string): string {
	return join(hostRunDir(), `${sessionId}.sock`);
}

/** Transient user unit name for one session host (contract §1/§7). */
export function hostUnitName(sessionId: string): string {
	return `omp-web-host-${sessionId}`;
}

/** Clear refusal for a session whose write lease belongs to another live process. */
export const FOREIGN_LEASE_ERROR =
	"This session is open in another omp process. Its history stays readable here, but it cannot be modified from omp-web until that process closes it.";

/** Bounded hello wait for discovery probes (mirrors the host-side live probe). */
const LIVE_PROBE_TIMEOUT_MS = 500;

/**
 * Read the host_hello a live host sends on every socket open. A bare connect
 * is safe (contract §3): the host's detach only drops the client, shutdown
 * requires SDK EOF or idle reap, and sending no inbound bytes never resets
 * the host's idle timer. Resolves null on connect error, close, or timeout.
 */
export function probeHostSocket(socketPath: string): Promise<HostHelloFrame | null> {
	return new Promise<HostHelloFrame | null>((resolve) => {
		let settled = false;
		let socket: Socket<{ buffer: string }> | undefined;
		const finish = (hello: HostHelloFrame | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try { socket?.end(); } catch { /* already gone */ }
			resolve(hello);
		};
		const timer = setTimeout(() => finish(null), LIVE_PROBE_TIMEOUT_MS);
		void Bun.connect<{ buffer: string }>({
			unix: socketPath,
			socket: {
				open: (s) => { socket = s; s.data = { buffer: "" }; },
				data: (s, chunk) => {
					const state = s.data;
					state.buffer += chunk.toString("utf8");
					for (;;) {
						const newline = state.buffer.indexOf("\n");
						if (newline === -1) return;
						const line = state.buffer.slice(0, newline).trim();
						state.buffer = state.buffer.slice(newline + 1);
						if (!line) continue;
						let parsed: unknown;
						try { parsed = JSON.parse(line); } catch { continue; }
						if (isHostHelloFrame(parsed)) {
							finish(parsed);
							return;
						}
					}
				},
				drain: () => {},
				close: () => finish(null),
				end: () => finish(null),
				error: () => finish(null),
				connectError: () => finish(null),
			},
		}).catch(() => finish(null));
	});
}

declare global {
	var __ompDiscoveredHosts: Map<string, DiscoveredHostEntry> | undefined;
	var __ompDiscoveredHostKeys: Map<string, string> | undefined;
}

export interface DiscoveredHostEntry {
	socketKey: string;
	pid: number;
	info: HostSessionInfoFrame;
}

export function getDiscoveredHosts(): Map<string, DiscoveredHostEntry> {
	if (!globalThis.__ompDiscoveredHosts) globalThis.__ompDiscoveredHosts = new Map();
	return globalThis.__ompDiscoveredHosts;
}

function getDiscoveredHostKeys(): Map<string, string> {
	if (!globalThis.__ompDiscoveredHostKeys) globalThis.__ompDiscoveredHostKeys = new Map();
	return globalThis.__ompDiscoveredHostKeys;
}

/** Sidecar-derived liveness (kill(pid, 0)); EPERM counts as alive. */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

/**
 * Refresh the realId → sidecar map from `<runDir>/*.info`. Sidecars only
 * exist for hosts whose session_info is actually emitted; entries whose pid
 * died are skipped (never deleted here — a concurrent host may be rewriting
 * the file). Cheap sync fs work; routes await it before reading the sync
 * running feeds.
 */
export async function refreshHostDiscovery(): Promise<void> {
	const discovered = getDiscoveredHosts();
	const keys = getDiscoveredHostKeys();
	let names: string[];
	try {
		names = readdirSync(hostRunDir());
	} catch {
		return; // unreadable dir: keep prior entries; pid liveness filters them
	}
	for (const name of names) {
		if (!name.endsWith(".info")) continue;
		let sidecar: HostDiscoverySidecar;
		try {
			const parsed: unknown = JSON.parse(readFileSync(join(hostRunDir(), name), "utf8"));
			if (!isHostDiscoverySidecar(parsed)) continue;
			sidecar = parsed;
		} catch {
			continue;
		}
		// Dead-pid entries are skipped, never deleted: a concurrent host may be
		// mid-rewrite and a parallel refresh must not drop a freshly added entry.
		// Consumers filter liveness via hasDiscoveredLiveHost / pid checks.
		if (!pidAlive(sidecar.pid)) continue;
		const realId = sidecar.info.sessionId;
		discovered.set(realId, { socketKey: sidecar.socketKey, pid: sidecar.pid, info: sidecar.info });
		keys.set(realId, sidecar.socketKey);
	}
}

/** Sidecar cwd for visibility checks — discovery never attaches (no idle reset). */
export function discoveredHostCwd(realId: string): string | undefined {
	return getDiscoveredHosts().get(realId)?.info.cwd;
}

/** True while a discovered host's pid is alive (sidecar-backed existence). */
export function hasDiscoveredLiveHost(realId: string): boolean {
	const entry = getDiscoveredHosts().get(realId);
	return entry !== undefined && pidAlive(entry.pid);
}

/** Probe at most this many sockets in parallel during the directory sweep. */
const SWEEP_CONCURRENCY = 8;

/**
 * Find the socket key of the live host serving `realId`. Fast path: a socket
 * keyed by the real id itself; then the sidecar/cached candidate; last resort
 * a bounded-concurrency sweep of every `*.sock` in the run dir (temp-keyed
 * hosts whose sidecar is gone). Every candidate is confirmed by its
 * host_hello.sessionId — a stale socket file alone is never trusted.
 */
export async function findHostSocketKeyForSession(realId: string): Promise<string | null> {
	const fastPath = await probeHostSocket(hostSocketPath(realId));
	if (fastPath?.sessionId === realId) return realId;

	const cachedKey = getDiscoveredHostKeys().get(realId);
	if (cachedKey && cachedKey !== realId) {
		const hello = await probeHostSocket(hostSocketPath(cachedKey));
		if (hello?.sessionId === realId) return cachedKey;
	}

	let names: string[];
	try {
		names = readdirSync(hostRunDir());
	} catch {
		return null;
	}
	const candidates = names
		.filter((name) => name.endsWith(".sock"))
		.map((name) => basename(name, ".sock"))
		.filter((key) => key !== realId && key !== cachedKey);
	for (let i = 0; i < candidates.length; i += SWEEP_CONCURRENCY) {
		const batch = candidates.slice(i, i + SWEEP_CONCURRENCY);
		const hellos = await Promise.all(batch.map(async (key) => ({
			key,
			hello: await probeHostSocket(hostSocketPath(key)),
		})));
		for (const { key, hello } of hellos) {
			if (hello?.sessionId !== realId) continue;
			getDiscoveredHostKeys().set(realId, key);
			return key;
		}
	}
	return null;
}

interface QueuedWrite {
	bytes: Uint8Array;
	offset: number;
}

export interface HostConnectionOptions {
	socketPath: string;
	/** Gate for kill(): only explicit user-driven termination may kill the host. */
	allowTerminate: () => boolean;
	/** Explicit termination: stop the host's transient unit, never a bare socket kill. */
	requestTerminate: () => void;
	/** Connection failure after open; the wrapper marks the host dead. */
	onError?: (error: Error) => void;
	/**
	 * Raw stdout tap (contract §3): when set, socket bytes go here instead of
	 * the RpcClient stream. The proxy re-serializes only forwarded frames back
	 * via feedStdout.
	 */
	rawStdout?: (chunk: Uint8Array) => void;
}

/**
 * A live (or connecting) UDS attachment. Construct, then `await opened` before
 * handing `process` to RpcClient.start().
 */
export class HostConnection {
	readonly process: RpcAgentProcess;
	/** Resolves on socket open; rejects on connect failure. */
	readonly opened: Promise<void>;

	private socket: Socket<undefined> | undefined;
	private closed = false;
	private queue: QueuedWrite[] = [];
	private stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
	private stdoutClosed = false;
	private readonly exitedResolve: (code: number) => void;
	private connectReject: ((error: Error) => void) | undefined;
	private connectResolve: (() => void) | undefined;

	constructor(private readonly options: HostConnectionOptions) {
		const { promise: exitedPromise, resolve } = Promise.withResolvers<number>();
		this.exitedResolve = resolve;
		const opened = Promise.withResolvers<void>();
		this.opened = opened.promise;
		this.connectResolve = opened.resolve;
		this.connectReject = opened.reject;
		this.opened.catch(() => {});

		const stdout = new ReadableStream<Uint8Array>({
			start: (controller) => {
				this.stdoutController = controller;
			},
			cancel: () => {
				// The RpcClient reader is gone; detach without touching the host.
				this.detach();
			},
		});

		this.process = {
			stdin: {
				write: (data: string | Uint8Array) => {
					this.writeBytes(typeof data === "string" ? Buffer.from(data, "utf8") : data);
				},
			},
			stdout,
			peekStderr: () => "",
			kill: () => {
				// Gated kill (contract §3): only explicit user-driven termination
				// reaches the host; every kill still detaches so RpcClient's
				// exit reaper settles instead of hanging on an open socket.
				if (this.options.allowTerminate()) this.options.requestTerminate();
				this.detach();
			},
			exited: exitedPromise,
		};

		void Bun.connect({
			unix: options.socketPath,
			socket: {
				open: (socket) => {
					this.socket = socket;
					this.connectResolve?.();
					this.connectResolve = undefined;
					this.connectReject = undefined;
				},
				data: (_socket, chunk) => {
					if (this.options.rawStdout) this.options.rawStdout(chunk);
					else this.pushStdout(chunk);
				},
				drain: () => {
					this.flushQueue();
				},
				close: () => {
					this.handleClosed();
				},
				end: () => {
					// Remote half-close: treat as host death, same as close.
					this.handleClosed();
				},
				error: (_socket, error) => {
					this.handleFailure(error);
				},
				connectError: (_socket, error) => {
					this.handleFailure(error);
				},
			},
		}).catch((error: unknown) => {
			this.handleFailure(error instanceof Error ? error : new Error(String(error)));
		});
	}

	/** Queue + partial-write pump. Never throws; a closed socket drops the bytes. */
	private writeBytes(bytes: Uint8Array): void {
		if (this.closed || bytes.length === 0) return;
		const socket = this.socket;
		if (socket && this.queue.length === 0) {
			const written = socket.write(bytes);
			if (written >= bytes.length) return;
			this.queue.push({ bytes, offset: Math.max(written, 0) });
			return;
		}
		this.queue.push({ bytes, offset: 0 });
	}

	private flushQueue(): void {
		const socket = this.socket;
		if (!socket || this.closed) return;
		while (this.queue.length > 0) {
			const head = this.queue[0];
			const written = socket.write(head.bytes.subarray(head.offset));
			if (written <= 0) return; // backpressure; wait for next drain
			head.offset += written;
			if (head.offset >= head.bytes.length) this.queue.shift();
			else return; // partial: wait for next drain
		}
	}

	private pushStdout(chunk: Uint8Array): void {
		if (this.stdoutClosed || !this.stdoutController) return;
		try {
			this.stdoutController.enqueue(chunk);
		} catch {
			this.stdoutClosed = true;
		}
	}

	private handleFailure(error: Error): void {
		if (this.connectReject) {
			this.connectReject(error);
			this.connectResolve = undefined;
			this.connectReject = undefined;
		} else if (!this.closed) {
			this.options.onError?.(error);
		}
		this.handleClosed();
	}

	private handleClosed(): void {
		if (this.closed) return;
		this.closed = true;
		this.queue = [];
		this.closeStdout();
		try {
			this.socket?.end();
		} catch {
			// already gone
		}
		this.socket = undefined;
		this.exitedResolve(0);
	}

	private closeStdout(): void {
		if (this.stdoutClosed) return;
		this.stdoutClosed = true;
		try {
			this.stdoutController?.close();
		} catch {
			// already closed/cancelled
		}
	}

	/** Drop the connection without terminating the host (web detach). */
	detach(): void {
		this.handleClosed();
	}

	/** Re-serialize forwarded frames into the RpcClient stdout stream (tap path). */
	feedStdout(bytes: Uint8Array): void {
		this.pushStdout(bytes);
	}

	get isClosed(): boolean {
		return this.closed;
	}
}

/** Connect to a host socket, waiting until it accepts (bounded). */
export async function connectToHost(options: HostConnectionOptions): Promise<HostConnection> {
	const connection = new HostConnection(options);
	await connection.opened;
	return connection;
}

/**
 * Connect with retries for the spawn race: systemd-run returns before the host
 * binds its socket. Bounded so a dead host cannot hang a route forever.
 */
export async function connectToHostWithRetry(
	options: HostConnectionOptions,
	timeoutMs = 15_000,
): Promise<HostConnection> {
	const deadline = Date.now() + timeoutMs;
	let lastError: Error | undefined;
	for (;;) {
		try {
			return await connectToHost(options);
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			if (Date.now() >= deadline) throw lastError;
			await Bun.sleep(150);
		}
	}
}
