/**
 * Slice A (issue #94, contract §§2–4): decorate the SDK's RpcExtensionUIContext
 * IN PLACE inside runRpcMode's `setToolUIContext` callback so extensions and
 * tools get the exact omp-web browser UI frames the old in-process wrapper
 * produced (rpc-manager.ts:1121–1415 port). The SDK's own
 * `pendingExtensionRequests` map is left untouched: host-decorated dialogs use
 * host-generated ids resolved from a host-side map, while login/open_url and
 * other SDK-issued requests keep flowing through the SDK's control-frame
 * dispatcher. `extension_ui_response` ids that match no host-pending request
 * fall through to the SDK (web-compat routing).
 */
import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { ThemeBg, ThemeColor } from "@oh-my-pi/pi-tui/theme";
import { Theme } from "@oh-my-pi/pi-coding-agent";
import { KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui";
import { randomUUID } from "crypto";
import { createHeadlessCustomUiTui, DEFAULT_CUSTOM_UI_COLUMNS } from "../../lib/custom-ui-terminal";
import type { ExtensionUiResponse, ExtensionWidgetItem } from "../../lib/types";

// Extensions require a complete Theme, while the web UI applies its own styling.
class PlainTextTheme extends Theme {
	constructor() {
		super(
			{ thinkingXhigh: "" } as Record<ThemeColor, string | number>,
			{} as Record<ThemeBg, string | number>,
			"truecolor",
			"unicode",
			{},
		);
	}

	override fg(color: ThemeColor, text: string): string { return text; }
	override bg(color: ThemeBg, text: string): string { return text; }
	override bold(text: string): string { return text; }
	override italic(text: string): string { return text; }
	override underline(text: string): string { return text; }
	override inverse(text: string): string { return text; }
	override strikethrough(text: string): string { return text; }
	override getFgAnsi(): string { return ""; }
	override getBgAnsi(): string { return ""; }
	override getThinkingBorderColor(): (text: string) => string {
		return (text) => text;
	}
	override getBashModeBorderColor(): (text: string) => string { return (text) => text; }
}

const PLAIN_TEXT_THEME = new PlainTextTheme();
const CUSTOM_UI_KEYBINDINGS = new TuiKeybindingsManager(TUI_KEYBINDINGS);

type PendingUiResponse = {
	resolve: (response: ExtensionUiResponse) => void;
	cancel: () => void;
};

type CustomUiComponent = {
	render: (width: number) => string[];
	handleInput?: (data: string) => void;
	dispose?: () => void;
	invalidate?: () => void;
};

type ActiveCustomUi = {
	component: CustomUiComponent;
	width: number;
	resolve: (value: unknown) => void;
	settled: boolean;
};

type ExtensionUiRequestBody = Record<string, unknown> & {
	method: string;
	timeout?: number;
	expiresAt?: number;
};

export interface WebUiDecoration {
	/** Resolve a host-pending dialog; false ⇒ id belongs to the SDK (forward). */
	resolveResponse(id: string, response: ExtensionUiResponse): boolean;
	/** Route raw keystrokes to a mounted custom UI component (extension_ui_input). */
	handleInput(id: string, data: unknown): void;
	getExtensionStatuses(): Array<{ key: string; text: string }>;
	getExtensionWidgets(): ExtensionWidgetItem[];
	/** Drop status/widget mirrors (reload / reloadPlugins parity). */
	clearDecoration(): void;
	/** Settle every pending dialog with its default and close custom UIs (teardown). */
	cancelAllPending(): void;
	/** Host-issued plan-review dialog (plan-mode proposal handler, contract §4). */
	requestPlanReview(title: string, planFilePath: string, planContent: string): Promise<string>;
}

function getCustomUiWidth(options: unknown): number {
	if (!options || typeof options !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
	const overlayOptions = (options as { overlayOptions?: unknown }).overlayOptions;
	const resolved = typeof overlayOptions === "function" ? overlayOptions() : overlayOptions;
	if (!resolved || typeof resolved !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
	const width = (resolved as { width?: unknown }).width;
	return typeof width === "number" && Number.isFinite(width)
		? Math.max(40, Math.min(140, Math.round(width)))
		: DEFAULT_CUSTOM_UI_COLUMNS;
}

/**
 * Mutate the SDK RPC UI context so every browser-facing method emits the
 * frozen omp-web frames. Called exactly once per host from main.ts's
 * `setToolUIContext` hook (contract §2: decorate INSIDE the callback).
 */
export function decorateWebUiContext(
	ctx: ExtensionUIContext,
	emit: (frame: object) => void,
): WebUiDecoration {
	const pendingUiResponses = new Map<string, PendingUiResponse>();
	const activeCustomUis = new Map<string, ActiveCustomUi>();
	const extensionStatuses = new Map<string, string>();
	const extensionWidgets = new Map<string, ExtensionWidgetItem>();

	function requestExtensionUi<T>(
		request: ExtensionUiRequestBody,
		defaultValue: T,
		parseResponse: (response: ExtensionUiResponse) => T,
		timeout?: number,
		signal?: AbortSignal,
	): Promise<T> {
		if (signal?.aborted) return Promise.resolve(defaultValue);

		const id = randomUUID();
		const fullRequest = {
			type: "extension_ui_request",
			id,
			...request,
			...(timeout ? { timeout, expiresAt: Date.now() + timeout } : {}),
		};

		const { promise, resolve } = Promise.withResolvers<T>();
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		const cleanup = (cancelled: boolean) => {
			clearTimeout(timeoutId);
			signal?.removeEventListener("abort", onAbort);
			pendingUiResponses.delete(id);
			// Wrapper-consumed dismissal so the browser clears the dialog when the
			// host times out, aborts, or tears down (slice B pin #4).
			if (cancelled) emit({ type: "extension_ui_request", method: "cancel", targetId: id });
		};
		const settle = (value: T, cancelled: boolean) => {
			cleanup(cancelled);
			resolve(value);
		};
		const onAbort = () => settle(defaultValue, true);

		if (timeout) timeoutId = setTimeout(() => settle(defaultValue, true), timeout);
		signal?.addEventListener("abort", onAbort, { once: true });

		pendingUiResponses.set(id, {
			resolve: (response) => settle(parseResponse(response), false),
			cancel: () => settle(defaultValue, true),
		});
		emit(fullRequest);
		return promise;
	}

	function emitCustomUiRender(id: string, custom: ActiveCustomUi): void {
		let lines: string[];
		try {
			lines = custom.component.render(custom.width);
		} catch (error) {
			lines = [`Extension custom UI render failed: ${error instanceof Error ? error.message : String(error)}`];
		}
		emit({ type: "extension_ui_request", id, method: "custom", lines });
	}

	function closeCustomUi(id: string, value: unknown): void {
		const custom = activeCustomUis.get(id);
		if (!custom || custom.settled) return;
		custom.settled = true;
		activeCustomUis.delete(id);
		try {
			custom.component.dispose?.();
		} catch {
			// Ignore dispose errors from extension UI components.
		}
		emit({ type: "extension_ui_request", id, method: "custom", lines: [], closed: true });
		custom.resolve(value);
	}

	function requestExtensionCustomUi<T>(factory: unknown, options?: unknown): Promise<T> {
		if (typeof factory !== "function") return Promise.resolve(undefined as T);

		const id = randomUUID();
		const width = getCustomUiWidth(options);

		const { promise, resolve } = Promise.withResolvers<T>();
		let completed = false;
		const tui = createHeadlessCustomUiTui(
			() => {
				const custom = activeCustomUis.get(id);
				if (custom) emitCustomUiRender(id, custom);
			},
			width,
		);
		const finish = (value: T) => {
			if (completed) return;
			completed = true;
			resolve(value);
		};
		const done = (value: T) => {
			if (activeCustomUis.has(id)) {
				closeCustomUi(id, value);
			} else {
				finish(value);
			}
		};

		Promise.resolve()
			.then(() => factory(tui, PLAIN_TEXT_THEME, CUSTOM_UI_KEYBINDINGS, done))
			.then((component) => {
				if (completed) {
					try {
						(component as CustomUiComponent | undefined)?.dispose?.();
					} catch {
						// Ignore dispose errors from a component completed before mounting.
					}
					return;
				}
				if (!component || typeof component !== "object" || typeof (component as CustomUiComponent).render !== "function") {
					finish(undefined as T);
					return;
				}
				const custom: ActiveCustomUi = {
					component: component as CustomUiComponent,
					width,
					resolve: (value) => finish(value as T),
					settled: false,
				};
				activeCustomUis.set(id, custom);
				emitCustomUiRender(id, custom);
			})
			.catch((error) => {
				if (completed) return;
				emit({
					type: "extension_error",
					extensionPath: `custom-ui:${id}`,
					event: "custom_ui",
					error: error instanceof Error ? error.message : String(error),
				});
				finish(undefined as T);
			});
		return promise;
	}

	// ---------------------------------------------------------------- overrides
	ctx.timeoutStartsOnPresentation = false;

	ctx.select = (title: string, options: ExtensionUISelectItem[], opts?: ExtensionUIDialogOptions) =>
		requestExtensionUi(
			{ method: "select", title, options, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
			undefined,
			(response) => "value" in response ? response.value : undefined,
			opts?.timeout,
			opts?.signal,
		);

	ctx.confirm = (title: string, message: string, opts?: ExtensionUIDialogOptions) =>
		requestExtensionUi(
			{ method: "confirm", title, message, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
			false,
			(response) => "confirmed" in response ? response.confirmed : false,
			opts?.timeout,
			opts?.signal,
		);

	ctx.input = (title: string, placeholder?: string, opts?: ExtensionUIDialogOptions) =>
		requestExtensionUi(
			{ method: "input", title, ...(placeholder !== undefined ? { placeholder } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
			undefined,
			(response) => "value" in response ? response.value : undefined,
			opts?.timeout,
			opts?.signal,
		);

	ctx.editor = (title: string, prefill?: string, opts?: ExtensionUIDialogOptions) =>
		requestExtensionUi(
			{ method: "editor", title, ...(prefill !== undefined ? { prefill } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
			undefined,
			(response) => "value" in response ? response.value : undefined,
			opts?.timeout,
			opts?.signal,
		);

	// The browser always renders the rich ask dialog: force it available
	// regardless of the SDK's set_ask_dialog opt-in (contract §2). The SDK
	// declares askDialog as a prototype getter, so shadow it with an own value.
	Object.defineProperty(ctx, "askDialog", {
		configurable: true,
		writable: true,
		value: (questions: ExtensionAskDialogQuestion[], opts?: ExtensionUIDialogOptions) =>
			requestExtensionUi(
				{ method: "ask", questions, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
				undefined as ExtensionAskDialogResult | undefined,
				(response) => {
					if (!("value" in response)) return undefined;
					try {
						return JSON.parse(response.value) as ExtensionAskDialogResult;
					} catch {
						return undefined;
					}
				},
				opts?.timeout,
				opts?.signal,
			),
	});

	ctx.notify = (message: string, type?: "info" | "warning" | "error") => {
		emit({ type: "extension_ui_request", id: randomUUID(), method: "notify", message, notifyType: type });
	};

	ctx.setStatus = (key: string, text: string | undefined) => {
		if (text === undefined) extensionStatuses.delete(key);
		else extensionStatuses.set(key, text);
		emit({ type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey: key, statusText: text });
	};

	ctx.setWidget = (key, content, options) => {
		if (content !== undefined && !Array.isArray(content)) return;
		if (content === undefined) {
			extensionWidgets.delete(key);
		} else {
			extensionWidgets.set(key, {
				key,
				lines: content,
				placement: options?.placement ?? "aboveEditor",
			});
		}
		emit({
			type: "extension_ui_request",
			id: randomUUID(),
			method: "setWidget",
			widgetKey: key,
			widgetLines: content,
			widgetPlacement: options?.placement,
		});
	};

	ctx.setTitle = (title: string) => {
		emit({ type: "extension_ui_request", id: randomUUID(), method: "setTitle", title });
	};

	ctx.custom = <T>(factory: unknown, options?: unknown) => requestExtensionCustomUi<T>(factory, options);

	ctx.setEditorText = (text: string) => {
		emit({ type: "extension_ui_request", id: randomUUID(), method: "set_editor_text", text });
	};
	ctx.pasteToEditor = ctx.setEditorText;

	ctx.getEditorText = () => "";
	ctx.setWorkingMessage = () => {};
	ctx.setFooter = () => {};
	ctx.setHeader = () => {};
	ctx.addAutocompleteProvider = () => {};
	ctx.setEditorComponent = () => {};
	ctx.getToolsExpanded = () => false;
	ctx.setToolsExpanded = () => {};
	ctx.onTerminalInput = () => () => {};

	Object.defineProperty(ctx, "theme", { configurable: true, value: PLAIN_TEXT_THEME });
	ctx.getAllThemes = async () => [];
	ctx.getTheme = async () => undefined;
	ctx.setTheme = async () => ({ success: false, error: "Theme switching is not supported in omp-web extension UI yet" });

	return {
		resolveResponse(id, response) {
			const pending = pendingUiResponses.get(id);
			if (!pending) return false;
			pending.resolve(response);
			return true;
		},
		handleInput(id, data) {
			const custom = activeCustomUis.get(id);
			if (!custom || typeof data !== "string") return;
			try {
				custom.component.handleInput?.(data);
				if (activeCustomUis.has(id)) emitCustomUiRender(id, custom);
			} catch (error) {
				closeCustomUi(id, undefined);
				emit({
					type: "extension_error",
					extensionPath: `custom-ui:${id}`,
					event: "custom_ui_input",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		},
		getExtensionStatuses() {
			return Array.from(extensionStatuses, ([key, text]) => ({ key, text }));
		},
		getExtensionWidgets() {
			return Array.from(extensionWidgets.values());
		},
		clearDecoration() {
			extensionStatuses.clear();
			extensionWidgets.clear();
		},
		cancelAllPending() {
			for (const pending of Array.from(pendingUiResponses.values())) pending.cancel();
			pendingUiResponses.clear();
			for (const id of Array.from(activeCustomUis.keys())) closeCustomUi(id, undefined);
		},
		requestPlanReview(title, planFilePath, planContent) {
			return requestExtensionUi(
				{ method: "plan_review", title, planFilePath, planContent },
				JSON.stringify({ action: "refine" }),
				(response) => "value" in response ? response.value : JSON.stringify({ action: "refine" }),
			);
		},
	};
}
