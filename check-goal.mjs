import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setImmediate as nextTask } from "node:timers/promises";
import { model, piDir } from "./check.mjs";

const goalEntry = process.argv[2];
assert.ok(goalEntry, "Pass the installed Goal extension entry path.");
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(pathToFileURL(join(piDir, "dist/index.js")).href);
const { createAssistantMessageEventStream, InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
const failoverEntry = process.argv[3] ? resolve(process.argv[3]) : fileURLToPath(new URL("./index.ts", import.meta.url));
const quota = "The usage limit has been reached";
const temporary = "Provider error (503): Service temporarily unavailable";
const unavailable = "Provider API error (404): {\"code\":\"model_not_found\",\"message\":\"Model is not available for this group\"}";
const upstream = "upstream_error: Upstream request failed";

async function runCase(goalFirst, scenario) {
  const dir = mkdtempSync(join(tmpdir(), "pi-failover-goal-check-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  let session;
  try {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const paths = [resolve(goalEntry), failoverEntry];
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
      additionalExtensionPaths: goalFirst ? paths : paths.reverse(), noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: join(dir, "models.json"), modelsStorePath: join(dir, "models-store.json") });
    for (const provider of scenario.providers) runtime.registerProvider(provider, { baseUrl: "https://example.invalid/v1", apiKey: "test", api: "test-api", models: [model(provider)] });
    const sessionManager = SessionManager.inMemory(dir);
    const goalStates = () => sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === "goal-state").map((e) => e.data.goal).filter(Boolean);
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel(scenario.initial, "test-model"), thinkingLevel: "xhigh", settingsManager, resourceLoader: loader, sessionManager, noTools: "builtin" }));
    const errors = [], requests = [];
    await session.bindExtensions({ mode: "print", onError: (e) => errors.push(e) });
    session.agent.streamFunction = (selected) => {
      requests.push(selected.provider);
      assert.ok(requests.length <= 4, "Recovery must not loop.");
      const stream = createAssistantMessageEventStream();
      const goal = goalStates().at(-1);
      const error = scenario.errors?.[selected.provider] ?? (selected.provider === scenario.failing ? scenario.error : undefined);
      const message = { role: "assistant", provider: selected.provider, model: selected.id, api: selected.api,
        content: error ? [] : [{ type: "toolCall", id: "complete-test", name: "goal_complete", arguments: { goal_id: goal.id, summary: "Verified the synthetic backup request completed with the original Goal active." } }],
        stopReason: error ? "error" : "toolUse", errorMessage: error, timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push(error ? { type: "error", reason: "error", error: message } : { type: "done", reason: "toolUse", message });
      stream.end(message);
      return stream;
    };
    if (scenario.threshold) await session.prompt(`/failover threshold ${scenario.threshold}`);
    await session.prompt(`/failover on ${scenario.providers.join(",")}`);
    await session.prompt("/goal Verify synthetic failover without stopping the Goal.");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await nextTask();
      if (session.isIdle && goalStates().some((goal) => goal.status !== "active")) break;
    }
    const states = goalStates();
    assert.deepEqual(errors, []);
    assert.deepEqual(requests, scenario.requests);
    assert.ok(states.length > 0);
    assert.deepEqual([...new Set(states.map((goal) => goal.status))], scenario.statuses ?? ["active", "complete"], "Goal must only stop after every eligible provider fails.");
    assert.equal(new Set(states.map((goal) => goal.id)).size, 1, "Recovery must keep the original Goal ID.");
    assert.equal(session.thinkingLevel, "xhigh");
    assert.ok(!session.messages.some((m) => m.role === "custom" && m.customType === "provider-failover-continue"), "Goal owns the continuation; failover must not inject another prompt.");
    const outcome = scenario.statuses?.includes("blocked") ? "after all eligible providers failed" : "without a stopped Goal";
    console.log(`PASS: ${scenario.name} ${outcome} (${goalFirst ? "Goal" : "failover"} loaded first)`);
  } finally {
    if (session) { await session.abort(); session.dispose(); }
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

const scenarios = [
  { name: "quota failover", providers: ["primary", "backup"], initial: "primary", failing: "primary", error: quota, requests: ["primary", "backup"] },
  { name: "middle-priority temporary failover", providers: ["preferred", "current", "backup"], initial: "current", failing: "current", error: temporary, threshold: 1, requests: ["current", "backup"] },
  { name: "unavailable model continues downward", providers: ["primary", "middle", "backup"], initial: "primary", errors: { primary: quota, middle: unavailable }, requests: ["primary", "middle", "backup"] },
  { name: "last-provider upstream failure wraps after cooldown", providers: ["primary", "middle", "backup"], initial: "backup", failing: "backup", error: upstream, requests: ["backup", "primary"] },
  { name: "all providers exhausted stops once", providers: ["primary", "middle", "backup"], initial: "primary", errors: { primary: quota, middle: unavailable, backup: upstream }, requests: ["primary", "middle", "backup"], statuses: ["active", "blocked"] },
];
for (const scenario of scenarios) {
  await runCase(true, scenario);
  await runCase(false, scenario);
}
