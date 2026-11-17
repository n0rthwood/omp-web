import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  refreshProviderModels,
  serializeHeaderRows,
  setCompatBool,
  updateHeaderRow,
} = await jiti.import("./models-config-helpers.ts");
const { getCurrentMachineId, setCurrentMachineId } = await jiti.import("../lib/api-path.ts");

const source = await readFile(new URL("./ModelsConfig.tsx", import.meta.url), "utf8");

test("custom model config exposes provider-level request headers", () => {
  const providerDetail = source.slice(
    source.indexOf("function ProviderDetail"),
    source.indexOf("// ── ThinkingLevelMap editor"),
  );
  assert.match(providerDetail, /<HeaderListEditor/);
  assert.match(providerDetail, /headers=\{provider\.headers\}/);
  assert.match(providerDetail, /set\("headers", headers\)/);
});

test("custom model config exposes model headers and supportsDeveloperRole compat flag", () => {
  // Model-level headers editor, wired to the model entry.
  assert.match(source, /headers=\{model\.headers\}/);
  assert.match(source, /set\("headers", headers\)/);

  // Model-level compat toggle reads the effective (provider+model) value so
  // hand-edited models.json settings are reflected, while writes stay on the
  // model entry as an explicit per-model override.
  assert.match(source, /effectiveCompat\(provider, model\)\["supportsDeveloperRole"\] !== false/);
  assert.match(source, /setCompatBool\(model, "supportsDeveloperRole", v\)/);
});

test("disabling the developer role writes an explicit false override", () => {
  assert.deepEqual(
    setCompatBool({ compat: { supportsStore: true } }, "supportsDeveloperRole", false),
    { compat: { supportsStore: true, supportsDeveloperRole: false } },
  );
});

test("editing a header preserves row order and stable identities", () => {
  const rows = [
    { id: 10, name: "X-First", value: "one" },
    { id: 11, name: "X-Second", value: "two" },
  ];
  const updated = updateHeaderRow(rows, 10, { name: "X-First-Edited" });

  assert.deepEqual(updated.map(({ id, name }) => ({ id, name })), [
    { id: 10, name: "X-First-Edited" },
    { id: 11, name: "X-Second" },
  ]);
  assert.deepEqual(serializeHeaderRows(updated), {
    "X-First-Edited": "one",
    "X-Second": "two",
  });
});

test("blank header drafts are omitted until they have a name", () => {
  const rows = [
    { id: 1, name: "X-Existing", value: "kept" },
    { id: 2, name: "", value: "draft value" },
  ];

  assert.deepEqual(serializeHeaderRows(rows), { "X-Existing": "kept" });
  assert.deepEqual(
    serializeHeaderRows(updateHeaderRow(rows, 2, { name: "X-Draft" })),
    { "X-Existing": "kept", "X-Draft": "draft value" },
  );
});

test("refresh posts the saved provider to the selected fleet machine and reloads models", async () => {
  const previousMachineId = getCurrentMachineId();
  let request;
  let modelReloads = 0;
  try {
    setCurrentMachineId("remote #1");
    const result = await refreshProviderModels("provider-a", () => { modelReloads += 1; }, async (url, options) => {
      request = { url, options };
      return Response.json({ success: true, discoveryStatus: "empty", warning: "No models reported" });
    });

    assert.equal(request.url, "/api/machines/remote%20%231/api/models-config/refresh-provider");
    assert.equal(request.options.method, "POST");
    assert.equal(request.options.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(request.options.body), { providerName: "provider-a" });
    assert.equal(result.discoveryStatus, "empty");
    assert.equal(result.warning, "No models reported");
    assert.equal(modelReloads, 1);
  } finally {
    setCurrentMachineId(previousMachineId);
  }
});

test("refresh surfaces server failure and still reloads models after a possible partial change", async () => {
  let modelReloads = 0;
  await assert.rejects(
    refreshProviderModels("provider-a", () => { modelReloads += 1; }, async () => (
      Response.json({ error: "Discovery unavailable" }, { status: 502 })
    )),
    { message: "Discovery unavailable" },
  );
  assert.equal(modelReloads, 1);
});

test("refresh reloads models when the connection fails or an error response is not JSON", async () => {
  let modelReloads = 0;
  const offline = new Error("connection lost");
  await assert.rejects(
    refreshProviderModels("provider-a", () => { modelReloads += 1; }, async () => { throw offline; }),
    (error) => error === offline,
  );
  await assert.rejects(
    refreshProviderModels("provider-a", () => { modelReloads += 1; }, async () => new Response("bad gateway", { status: 502 })),
    { message: "HTTP 502" },
  );
  assert.equal(modelReloads, 2);
});
