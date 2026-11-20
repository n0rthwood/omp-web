import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ChatInput, ModelErrorBanner, ModelScopeWarningBanner, canRestoreUserMessage, filterModelOptions, getUserMessageText, getUserMessageDraftImages, buildImageAttachErrorMessage, resolveImageMimeType } = await jiti.import("./ChatInput.tsx");
const { clearDraft, getDraft, mergeRestoredSubmissionDraft, mergeRestoredSubmissionText, rekeyDraft, setDraft } = await jiti.import("../lib/draft-store.ts");
const draftStore = await jiti.import("../lib/draft-store.ts");
const chatInputSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { MAX_ATTACHED_IMAGE_BYTES, MAX_ATTACHED_IMAGES } = await jiti.import("../lib/image-attachments.ts");
const { translateMessage } = await jiti.import("../lib/i18n/format.ts");
const { enLocale } = await jiti.import("../lib/i18n/messages/en.ts");
const { zhCNLocale } = await jiti.import("../lib/i18n/messages/zh-CN.ts");

test("renders the upstream model error", () => {
  const html = renderToStaticMarkup(
    React.createElement(ModelErrorBanner, {
      error: "Invalid models.json schema:\nproviders.custom.models.0.id must not be empty",
    }),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Model error/);
  assert.match(html, /providers\.custom\.models\.0\.id must not be empty/);
});

test("does not render an empty model error", () => {
  assert.equal(renderToStaticMarkup(React.createElement(ModelErrorBanner, { error: null })), "");
});

test("renders enabledModels scope warnings", () => {
  const html = renderToStaticMarkup(
    React.createElement(ModelScopeWarningBanner, {
      warnings: ['No models match pattern "ghost-gateway/*"'],
    }),
  );

  assert.match(html, /Model scope warning/);
  assert.match(html, /ghost-gateway/);
  assert.equal(renderToStaticMarkup(React.createElement(ModelScopeWarningBanner, { warnings: [] })), "");
});

test("keeps the model selector visible when a model error leaves no options", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onModelChange() {},
        isStreaming: false,
        modelError: "Invalid models.json schema",
        modelList: [],
        modelNames: {},
      }),
    ),
  );

  assert.match(html, />No models</);
  assert.match(html, /title="No available models"/);
});

test("shows and locks the optimistic model while a switch is pending", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onModelChange() {},
        isStreaming: false,
        model: { provider: "deepseek", modelId: "deepseek-v4-flash" },
        modelList: [{ provider: "deepseek", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
        modelSwitching: true,
      }),
    ),
  );

  assert.match(html, /title="Switching model"/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /disabled=""/);
  assert.match(html, />DeepSeek V4 Flash</);
  assert.match(html, /animation:spin 0\.8s linear infinite/);
});

test("filters model options by name, id and provider", () => {
  const options = [
    { provider: "ollama", modelId: "qwen3:latest", name: "Qwen 3" },
    { provider: "anthropic", modelId: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { provider: "openai", modelId: "gpt-5.4", name: "GPT-5.4" },
    // A provider's own name appears in neither the model name nor its id, which
    // is exactly what made "openrouter" unsearchable (#111).
    { provider: "openrouter", modelId: "qwen/qwen3-coder:free", name: "Qwen3 Coder 480B A35B (free)" },
  ];

  assert.deepEqual(filterModelOptions(options, "QWEN"), [options[0], options[3]]);
  assert.deepEqual(filterModelOptions(options, "claude-sonnet"), [options[1]]);
  assert.deepEqual(filterModelOptions(options, "OpenAI"), [options[2]]);
  assert.deepEqual(filterModelOptions(options, "openrouter"), [options[3]]);
  assert.equal(filterModelOptions(options, "anthropic/claude").length, 0);
  assert.equal(filterModelOptions(options, "missing").length, 0);
  assert.equal(filterModelOptions(options, "  "), options);
});

test("restores text and base64 images when editing a user message", () => {
  const message = {
    role: "user",
    content: [
      { type: "text", text: "Review this image @src/example.ts " },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
    ],
  };

  assert.equal(getUserMessageText(message), "Review this image @src/example.ts ");
  assert.deepEqual(getUserMessageDraftImages(message), [
    { data: "AQID", mimeType: "image/png" },
  ]);
});

test("restores legacy flat image entries when editing a user message", () => {
  const message = {
    role: "user",
    content: [
      { type: "image", data: "AQID", mimeType: "image/jpeg" },
    ],
  };

  assert.deepEqual(getUserMessageDraftImages(message), [
    { data: "AQID", mimeType: "image/jpeg" },
  ]);
});

test("does not restore a historical message over a pending image attachment", () => {
  assert.equal(canRestoreUserMessage("", 0, 0), true);
  assert.equal(canRestoreUserMessage("", 1, 0), false);
  assert.equal(canRestoreUserMessage("", 0, 1), false);
  assert.equal(canRestoreUserMessage("draft", 0, 0), false);
});

test("restores a cleared submission using the queued React state", () => {
  let value = "failed submission";
  const updates = [
    () => "",
    (current) => mergeRestoredSubmissionText("failed submission", current),
  ];

  for (const update of updates) value = update(value);

  assert.equal(value, "failed submission");
  assert.equal(
    mergeRestoredSubmissionText("failed submission", "new draft"),
    "failed submission\n\nnew draft",
  );
  assert.equal(
    mergeRestoredSubmissionText("failed submission", "failed submission"),
    "failed submission\n\nfailed submission",
  );
});

test("keeps a failed first submission recoverable across a composer remount", () => {
  const image = { data: "AQID", mimeType: "image/png" };
  const restored = mergeRestoredSubmissionDraft(
    "failed submission",
    [image],
    "",
    [],
  );

  assert.deepEqual(restored, {
    value: "failed submission",
    images: [image],
  });
  assert.deepEqual(
    mergeRestoredSubmissionDraft("failed submission", [image], "new draft", []),
    {
      value: "failed submission\n\nnew draft",
      images: [image],
    },
  );
});

test("preserves duplicate image attachments when restoring a submission", () => {
  const image = { data: "AQID", mimeType: "image/png" };
  const restored = mergeRestoredSubmissionDraft("", [image, image], "", [image]);

  assert.deepEqual(restored.images, [image, image, image]);
});

test("moves a provisional new-session draft to the real session key", () => {
  const provisionalKey = "new:/tmp/rekey-test";
  const sessionKey = "session-rekey-test";
  clearDraft(provisionalKey);
  clearDraft(sessionKey);
  setDraft(provisionalKey, { value: "queued while preflight ran", images: [] });

  assert.deepEqual(rekeyDraft(provisionalKey, sessionKey), {
    value: "queued while preflight ran",
    images: [],
  });
  assert.equal(getDraft(provisionalKey), null);
  assert.deepEqual(getDraft(sessionKey), {
    value: "queued while preflight ran",
    images: [],
  });

  clearDraft(sessionKey);
});

test("rekey keeps a synchronously restored draft when React state is still empty", () => {
  const provisionalKey = "new:/tmp/rekey-race";
  const sessionKey = "session-rekey-race";
  clearDraft(provisionalKey);
  clearDraft(sessionKey);
  setDraft(provisionalKey, { value: "restored before state flush", images: [] });

  assert.deepEqual(
    rekeyDraft(provisionalKey, sessionKey, { value: "", images: [] }),
    { value: "restored before state flush", images: [] },
  );
  assert.equal(getDraft(provisionalKey), null);
  assert.deepEqual(getDraft(sessionKey), {
    value: "restored before state flush",
    images: [],
  });

  clearDraft(sessionKey);
});

test("renders compact errors above the input as a wrapping alert", () => {
  const error = "Compaction failed: OpenAI API error (403): <html>request forbidden</html>";
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onCompact() {},
        isStreaming: false,
        compactError: error,
      }),
    ),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Compaction failed: OpenAI API error/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
  assert.match(html, /white-space:pre-wrap/);
  assert.ok(html.indexOf('role="alert"') < html.indexOf("<textarea"));
});

test("shows context occupancy and warning state", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        isStreaming: false,
        contextUsage: { tokens: 100_000, contextWindow: 128_000, percent: 78 },
      }),
    ),
  );

  assert.match(html, /role="status"/);
  assert.match(html, /data-context-level="warning"/);
  assert.match(html, /100k \/ 128k/);
  assert.match(html, /78%/);
  assert.match(html, /Context window is getting full/);
});
test("keeps the context indicator visible before usage is available", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        isStreaming: false,
      }),
    ),
  );

  assert.match(html, /role="status"/);
  assert.match(html, /data-context-available="false"/);
  assert.match(html, /\? \/ \?/);
});

function t(locale) {
  const messages = { en: enLocale.messages, "zh-CN": zhCNLocale.messages };
  return (key, params) => translateMessage(locale, key, messages, params);
}

test("does not report an image attachment error when nothing was rejected", () => {
  assert.equal(buildImageAttachErrorMessage(t("en"), [], [], 0), null);
});

test("reports oversized images instead of silently dropping them (#omp-web silent-drop bug)", () => {
  const maxMB = MAX_ATTACHED_IMAGE_BYTES / (1024 * 1024);
  const message = buildImageAttachErrorMessage(t("en"), ["photo.jpg"], [], 0);
  assert.match(message, /Skipped 1 image\(s\) over 10MB: photo\.jpg/);
  assert.equal(maxMB, 10);
});

test("reports unsupported file types and the per-message image cap", () => {
  const message = buildImageAttachErrorMessage(t("en"), [], ["notes.txt"], 2);
  assert.match(message, /Skipped 1 unsupported file\(s\): notes\.txt/);
  assert.match(message, new RegExp(`Only ${MAX_ATTACHED_IMAGES} images allowed per message; skipped 2 extra image\\(s\\)`));
});

test("combines every rejection reason into one message", () => {
  const message = buildImageAttachErrorMessage(t("en"), ["a.jpg", "b.jpg"], ["c.txt"], 1);
  assert.match(message, /Skipped 2 image\(s\) over 10MB: a\.jpg, b\.jpg/);
  assert.match(message, /Skipped 1 unsupported file\(s\): c\.txt/);
  assert.match(message, /skipped 1 extra image\(s\)/);
});

test("truncates a long list of rejected file names", () => {
  const names = ["a.jpg", "b.jpg", "c.jpg", "d.jpg", "e.jpg"];
  const message = buildImageAttachErrorMessage(t("en"), names, [], 0);
  assert.match(message, /a\.jpg, b\.jpg, c\.jpg \+2/);
});

test("translates the image attachment rejection message into zh-CN", () => {
  const message = buildImageAttachErrorMessage(t("zh-CN"), ["photo.jpg"], [], 0);
  assert.match(message, /已跳过 1 张超过 10MB 的图片：photo\.jpg/);
});

test("classifies attachments as images even when the picker reports no media type", () => {
  // `File.type` wins when present.
  assert.equal(resolveImageMimeType({ name: "shot.png", type: "image/png" }), "image/png");
  assert.equal(resolveImageMimeType({ name: "notes.txt", type: "text/plain" }), null);
  // Empty type: the extension is the only signal. Before this, a typeless
  // image was routed to the text uploader and rejected as binary (#69).
  assert.equal(resolveImageMimeType({ name: "IMG_0421.JPG", type: "" }), "image/jpeg");
  assert.equal(resolveImageMimeType({ name: "scan.heic", type: "" }), "image/heic");
  assert.equal(resolveImageMimeType({ name: "archive.zip", type: "" }), null);
  assert.equal(resolveImageMimeType({ name: "README", type: "" }), null);
  // PDFs are attachments but not images: they must reach the file uploader
  // (temp-dir path), not the image attachment path (#87).
  assert.equal(resolveImageMimeType({ name: "report.pdf", type: "application/pdf" }), null);
  assert.equal(resolveImageMimeType({ name: "REPORT.PDF", type: "" }), null);
});

// ── #88: a prompt is never lost until the conversation confirms it ─────────

function installLocalStorage() {
  const data = new Map();
  globalThis.localStorage = {
    get length() {
      return data.size;
    },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      data.set(key, String(value));
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
  draftStore.resetDraftStoreForTests();
}

function uninstallLocalStorage() {
  draftStore.resetDraftStoreForTests();
  delete globalThis.localStorage;
}

/** The textarea markup of a composer mounted for `draftKey`. */
function renderComposer(draftKey) {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, { onSend() {}, onAbort() {}, isStreaming: false, draftKey }),
    ),
  );
  return html.slice(html.indexOf("<textarea"), html.indexOf("</textarea>") + "</textarea>".length);
}

test("submitting keeps the text as a pending draft instead of deleting it (#88)", () => {
  const submitSource = chatInputSource.slice(
    chatInputSource.indexOf("  const submitInput = useCallback"),
    chatInputSource.indexOf("  useEffect(() => {", chatInputSource.indexOf("  const submitInput = useCallback")),
  );
  const clearInputSource = chatInputSource.slice(
    chatInputSource.indexOf("  const clearInput = useCallback"),
    chatInputSource.indexOf("  const submitInput = useCallback"),
  );

  assert.match(submitSource, /markDraftSubmitted\(sourceKey, text\);/);
  assert.doesNotMatch(submitSource, /clearDraft/);
  // Text the session consumes locally (shell/builtin commands) empties the
  // composer's draft but never clears the key: a submission still pending
  // under it (aborted or unconfirmed turn) is not that command's to drop.
  assert.match(clearInputSource, /setDraft\(draftKey, \{ value: "", images: \[\] \}\);/);
  assert.doesNotMatch(clearInputSource, /clearDraft/);
  assert.doesNotMatch(chatInputSource, /\bclearDraft\b/);
});

test("every send path hands its draft key to the session and keeps local commands out of it (#88)", () => {
  const sendSource = chatInputSource.slice(
    chatInputSource.indexOf("  const handleSend = useCallback"),
    chatInputSource.indexOf("  const slashQuery ="),
  );
  const queuedSource = chatInputSource.slice(
    chatInputSource.indexOf("  const sendQueued = useCallback"),
    chatInputSource.indexOf("  const getNextSlashIndex = useCallback"),
  );

  assert.match(sendSource, /onSend\(msg, images\.length \? images : undefined, submitInput\(msg\)\);/);
  assert.match(sendSource, /onSend\(result\.prompt, undefined, submitInput\(result\.prompt\)\);/);
  assert.match(sendSource, /msg\.startsWith\("!"\)\) \{\s*clearInput\(\);\s*onSend\(msg\);\s*return;/);
  assert.match(sendSource, /\} else \{\s*clearInput\(\);\s*\}/);
  assert.match(queuedSource, /onPromptWithStreamingBehavior\(msg, streamingBehavior, undefined, submitInput\(msg\)\);/);
  assert.match(queuedSource, /queue\(msg, undefined, submitInput\(msg\)\);/);
  assert.doesNotMatch(queuedSource, /clearInput/);
});

test("a failed send is restored through the store so its pending marker is released (#88)", () => {
  const restoreSource = chatInputSource.slice(
    chatInputSource.indexOf("    restoreSubmission(text: string"),
    chatInputSource.indexOf("    insertText(text: string)"),
  );

  assert.match(restoreSource, /restoreDraftSubmission\(\s*destinationDraftKey,\s*text,\s*images,\s*targetsCurrentComposer \? liveDraft : undefined,\s*\)/);
  assert.doesNotMatch(restoreSource, /\bsetDraft\(/);
});

test("a provisional composer's draft moves to the session key exactly once on promotion (#88)", () => {
  const effectSource = chatInputSource.slice(
    chatInputSource.indexOf("    if (previousDraftKey === draftKey) return;"),
    chatInputSource.indexOf("  // The web user, and with it the scope drafts are stored under"),
  );

  assert.match(effectSource, /isProvisionalDraftKey\(previousDraftKey\) && !isProvisionalDraftKey\(draftKey\)/);
  assert.match(effectSource, /moveComposerDraft\(previousDraftKey, draftKey\);\s*return;/);
  assert.match(chatInputSource, /rekeyDraft\(previousKey: string, nextKey: string\) \{\s*moveComposerDraft\(previousKey, nextKey\);\s*\},/);
  // ChatWindow still builds the `new:<cwd>` keys the draft store recognises.
  assert.match(chatWindowSource, /draftKey=\{session\?\.id \?\? \(newSessionCwd \? `new:\$\{newSessionCwd\}` : undefined\)\}/);
  assert.equal(draftStore.isProvisionalDraftKey("new:/work"), true);
});

test("a composer mounted for a conversation still sending shows an empty draft (#88)", () => {
  installLocalStorage();
  try {
    draftStore.setDraft("new:/work", { value: "first prompt", images: [] });
    draftStore.markDraftSubmitted("new:/work", "first prompt");

    // The first optimistic message remounts the composer under the same key.
    assert.doesNotMatch(renderComposer("new:/work"), /first prompt/);
    assert.equal(draftStore.getDraftStatus("new:/work"), "pending");
  } finally {
    uninstallLocalStorage();
  }
});

test("a failed first send shows up in the remounted new-conversation composer (#88)", () => {
  installLocalStorage();
  try {
    draftStore.setDraft("new:/work", { value: "first prompt", images: [] });
    draftStore.markDraftSubmitted("new:/work", "first prompt");
    assert.doesNotMatch(renderComposer("new:/work"), /first prompt/);

    // ChatInput.restoreSubmission resolves to this for the visible key.
    draftStore.restoreDraftSubmission("new:/work", "first prompt");
    assert.match(renderComposer("new:/work"), />first prompt<\/textarea>/);
    assert.doesNotMatch(renderComposer("session-created-by-ensure"), /first prompt/);
    assert.equal(draftStore.getDraftStatus("new:/work"), "editing");
  } finally {
    uninstallLocalStorage();
  }
});

test("a composer mounted after a reload shows an unconfirmed submission as editable text (#88)", () => {
  installLocalStorage();
  try {
    draftStore.markDraftSubmitted("new:/work", "first prompt");
    draftStore.setDraft("new:/work", { value: "typed afterwards", images: [] });
    draftStore.flushDrafts();
    draftStore.resetDraftStoreForTests();

    assert.match(renderComposer("new:/work"), />first prompt\n\ntyped afterwards<\/textarea>/);
    assert.equal(draftStore.getDraftStatus("new:/work"), "editing");
  } finally {
    uninstallLocalStorage();
  }
});

test("promotion hands the session composer the moved draft and leaves the provisional key empty (#88)", () => {
  installLocalStorage();
  try {
    draftStore.markDraftSubmitted("new:/work", "first prompt");
    draftStore.setDraft("new:/work", { value: "typed meanwhile", images: [] });

    draftStore.rekeyDraft("new:/work", "session-1", { value: "typed meanwhile", images: [] });
    assert.match(renderComposer("session-1"), />typed meanwhile<\/textarea>/);
    assert.doesNotMatch(renderComposer("new:/work"), /typed meanwhile|first prompt/);
    assert.equal(draftStore.getDraftStatus("new:/work"), null);

    // Confirmation under the session key releases the submission but not the typed text.
    draftStore.confirmDraft("session-1");
    assert.match(renderComposer("session-1"), />typed meanwhile<\/textarea>/);
    assert.equal(draftStore.getDraftStatus("session-1"), "editing");
  } finally {
    uninstallLocalStorage();
  }
});
