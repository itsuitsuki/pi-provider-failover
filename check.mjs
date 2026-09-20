import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Run: node ~/.pi/agent/extensions/provider-failover/check.mjs
export const piDir = join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
registerHooks({ resolve(specifier, context, next) {
  if (["@earendil-works/pi-ai", "@earendil-works/pi-tui"].includes(specifier)) return next(pathToFileURL(join(piDir, "node_modules", specifier, "dist/index.js")).href, context);
  if (specifier === "@earendil-works/pi-coding-agent") return next(pathToFileURL(join(piDir, "dist/index.js")).href, context);
  return next(specifier, context);
} });
const configDir = mkdtempSync(join(tmpdir(), "pi-failover-defaults-check-"));
process.env.PI_CODING_AGENT_DIR = configDir;
process.once("exit", () => rmSync(configDir, { recursive: true, force: true }));
const defaultsPath = join(configDir, "provider-failover.json");
const { default: failover, classifyFailure } = await import("./index.ts");

export const model = (provider) => ({ provider, id: "test-model", name: "Test", api: "test-api", baseUrl: "https://example.invalid/v1", contextWindow: 272000, maxTokens: 4096, reasoning: true, input: ["text", "image"], thinkingLevelMap: { xhigh: "xhigh" }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
const quota = "The usage limit has been reached";
const temporary = 'Provider error (503): {"message":"Service temporarily unavailable","type":"api_error"}';
const unavailable = 'Provider API error (404): {"code":"model_not_found","message":"Model \\"test-model\\" is not available for this group"}';
const upstream = "upstream_error: Upstream request failed";
for (const error of [quota, "usage_limit_reached", "The service usage limit has been reached", '403: {"message":"insufficient quota","type":"billing_error"}']) assert.equal(classifyFailure(error), "quota");
for (const error of [temporary, "429 rate_limit_error", "server_error: overloaded", "524 status code (no body)", "stream_read_error"]) assert.equal(classifyFailure(error), "temporary");
assert.equal(classifyFailure(unavailable), "unavailable");
assert.equal(classifyFailure(upstream), "upstream");
for (const error of ["403 permission denied", "401 invalid_api_key", "404 not found", "context_length_exceeded", "This operation was aborted", "invalid request", "syntax error"]) assert.equal(classifyFailure(error), undefined);

function harness(providers = ["primary", "backup", "fallback"], entries = []) {
  const handlers = new Map(), commands = new Map(), switches = [], messages = [], notices = [];
  const events = new EventEmitter();
  const models = providers.map(model);
  let level = "xhigh";
  const ctx = { model: models[0], modelRegistry: {
    getAll: () => models, getAvailable: () => models,
    getProviderAuth: async (provider) => ({ auth: { apiKey: `test-${provider}` } }),
  }, sessionManager: { getBranch: () => entries }, isIdle: () => true, hasPendingMessages: () => false,
    ui: { notify: (text) => notices.push(text), setStatus() {} } };
  const emit = async (name, event = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
  const pi = {
    events: { emit: (name, data) => events.emit(name, data), on: (name, handler) => { events.on(name, handler); return () => events.off(name, handler); } },
    on: (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    registerCommand: (name, command) => commands.set(name, command),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
    setModel: async (target) => { ctx.model = target; switches.push(target.provider); await emit("model_select", { model: target }); return true; },
    getThinkingLevel: () => level, setThinkingLevel: (value) => { level = value; },
    sendMessage: (message) => messages.push(message),
  };
  failover(pi);
  return { ctx, emit, entries, models, switches, messages, notices, events,
    command: (args) => commands.get("failover").handler(args, ctx),
    end: async (error, stopReason = error ? "error" : "stop") => {
      const message = { role: "assistant", provider: ctx.model.provider, model: ctx.model.id, stopReason, errorMessage: error };
      await emit("message_end", { message });
      await emit("turn_end", { message, toolResults: [] });
      await emit("agent_end", { messages: [message] });
      return message;
    },
  };
}

const originalNow = Date.now;
let now = originalNow();
Date.now = () => now;
try {
  const h = harness();
  await h.end(quota); assert.deepEqual(h.switches, [], "disabled by default");
  await h.command("on primary,backup");
  await h.end(temporary); await h.end(temporary); assert.equal(h.switches.length, 0);
  await h.end(temporary); assert.deepEqual(h.switches, ["backup"]);
  await h.emit("agent_settled"); assert.equal(h.messages.length, 1);
  await h.end();
  await h.emit("before_agent_start"); assert.equal(h.ctx.model.provider, "backup");
  now += 301000;
  await h.emit("input", { source: "interactive" }); await h.emit("before_agent_start");
  assert.equal(h.ctx.model.provider, "primary");
  assert.deepEqual(h.entries.findLast((e) => e.customType === "provider-failover-switch").data,
    { from: "backup", to: "primary", model: "test-model", reason: "recovery" });
  await h.end(temporary); assert.equal(h.ctx.model.provider, "backup", "recovery failure falls back on the first error");
  await h.end(); now += 301000;
  await h.emit("input", { source: "interactive" }); await h.emit("before_agent_start"); await h.end();
  assert.equal(h.ctx.model.provider, "primary");
  assert.equal(h.entries.findLast((e) => e.customType === "provider-failover-recovery").data, null);

  const route = ["fallback", "primary", "backup"];
  const priorityFallback = harness(route);
  await priorityFallback.command(`on ${route.join(",")}`);
  await priorityFallback.end(quota); assert.equal(priorityFallback.ctx.model.provider, "primary");
  await priorityFallback.end();
  now += 299000; await priorityFallback.emit("before_agent_start");
  assert.equal(priorityFallback.ctx.model.provider, "primary", "higher-priority recovery waits for cooldown");
  const resumed = harness(route, structuredClone(priorityFallback.entries));
  resumed.ctx.model = resumed.models[1]; await resumed.emit("session_start");
  await resumed.emit("before_agent_start"); assert.equal(resumed.ctx.model.provider, "primary");
  now += 2000; await resumed.emit("before_agent_start");
  assert.equal(resumed.ctx.model.provider, "fallback", "higher-priority recovery survives resume");
  await resumed.end();
  assert.equal(resumed.entries.findLast((e) => e.customType === "provider-failover-recovery").data, null);

  const downwardOnly = harness(route);
  downwardOnly.ctx.model = downwardOnly.models[1];
  await downwardOnly.command(`on ${route.join(",")}`);
  await downwardOnly.end(temporary); await downwardOnly.end(temporary); await downwardOnly.end(temporary);
  assert.equal(downwardOnly.ctx.model.provider, "backup", "ordinary failures only move to lower-priority providers");
  assert.ok(!downwardOnly.switches.includes("fallback"), "higher-priority providers are reserved for cooldown recovery");

  const claimed = harness();
  await claimed.command("on primary,backup");
  const claimedMessage = await claimed.end(quota);
  const claim = { message: claimedMessage, claimed: false };
  claimed.events.emit("provider-failover:claim", claim);
  assert.equal(claim.claimed, true, "a workflow can claim continuation after a successful switch");
  await claimed.emit("agent_settled");
  assert.equal(claimed.messages.length, 0, "a claimed continuation must not inject a second prompt");

  const manual = harness(route);
  await manual.command(`on ${route.join(",")}`); await manual.end(quota); await manual.end();
  await manual.emit("model_select", { model: manual.ctx.model }); now += 301000;
  await manual.emit("before_agent_start"); assert.equal(manual.ctx.model.provider, "primary", "manual model choice cancels return");
  await manual.command(`on ${route.join(",")}`); await manual.command("cooldown 60");
  now += 61000; await manual.emit("before_agent_start");
  assert.equal(manual.ctx.model.provider, "fallback", "reenabling and shorter cooldown apply to return");
  const stopRecovery = harness(route);
  await stopRecovery.command(`on ${route.join(",")}`); await stopRecovery.end(quota); await stopRecovery.end();
  await stopRecovery.command("off"); now += 301000; await stopRecovery.emit("before_agent_start");
  assert.equal(stopRecovery.ctx.model.provider, "primary", "off cancels automatic return");

  const loop = harness(); await loop.command("on primary,backup");
  await loop.end(quota); await loop.end(quota); await loop.end(quota);
  assert.deepEqual(loop.switches, ["backup"], "no ping-pong when both providers fail");
  const unavailableFallback = harness(["primary", "middle", "backup"]); await unavailableFallback.command("on primary,middle,backup");
  await unavailableFallback.end(quota); assert.equal(unavailableFallback.ctx.model.provider, "middle");
  await unavailableFallback.end(unavailable); assert.equal(unavailableFallback.ctx.model.provider, "backup", "an unavailable model must continue to the next provider");
  await unavailableFallback.end(upstream); assert.deepEqual(unavailableFallback.switches, ["middle", "backup"], "a failed provider must not be retried in the same chain");
  const wrappedFallback = harness(["primary", "middle", "backup"]); wrappedFallback.ctx.model = wrappedFallback.models[2];
  await wrappedFallback.command("on primary,middle,backup"); await wrappedFallback.end(upstream);
  assert.equal(wrappedFallback.ctx.model.provider, "primary", "the last provider wraps to an eligible cooled-down provider");
  const cancelled = harness(); await cancelled.command("on primary,backup");
  cancelled.ctx.signal = AbortSignal.abort(); await cancelled.end(quota); assert.equal(cancelled.switches.length, 0);
  const checkpoint = harness(); await checkpoint.command("on primary,backup");
  checkpoint.entries.push({ type: "compaction", summary: "", details: { strategy: "native-compaction-v1" } });
  await checkpoint.end(quota); assert.equal(checkpoint.switches.length, 0);
  const incompatible = harness(); await incompatible.command("on primary,backup");
  incompatible.models[1].thinkingLevelMap.xhigh = null; await incompatible.end(quota); assert.equal(incompatible.switches.length, 0);
  const off = harness(); await off.command("on primary,backup"); await off.command("off"); await off.end(quota); assert.equal(off.switches.length, 0);
  const streak = harness(); await streak.command("on primary,backup");
  await streak.end(temporary); await streak.end(temporary);
  await streak.emit("message_end", { message: { role: "assistant", provider: "primary", model: "test-model", stopReason: "toolUse" } });
  await streak.end(temporary); assert.equal(streak.switches.length, 0, "a successful tool turn resets consecutive errors");
  const restored = harness(undefined, h.entries); await restored.emit("session_start"); await restored.end(quota); assert.equal(restored.ctx.model.provider, "backup");

  console.log("PASS: quota/error classification, opt-in, recovery, loop/cancel and checkpoint guards");

  const defaultsCommand = harness(route);
  await defaultsCommand.emit("session_start"); await defaultsCommand.command("default");
  assert.match(defaultsCommand.notices.at(-1), /New-session default: OFF/);
  assert.equal(existsSync(defaultsPath), false, "viewing defaults must not create settings");
  await defaultsCommand.command("default fallback,primary,backup");
  assert.deepEqual(JSON.parse(readFileSync(defaultsPath, "utf8")), { enabled: true, providers: route });
  assert.equal(defaultsCommand.entries.findLast((entry) => entry.customType === "provider-failover").data.enabled, true);
  const fresh = harness(route); await fresh.emit("session_start");
  await fresh.end(quota);
  assert.equal(fresh.ctx.model.provider, "primary", "a new session must fail over without an on command");
  const startOnBackup = harness(route); startOnBackup.ctx.model = startOnBackup.models[2];
  await startOnBackup.emit("session_start"); now += 301000; await startOnBackup.emit("before_agent_start");
  assert.equal(startOnBackup.ctx.model.provider, "fallback", "default-enabled sessions establish automatic recovery");
  await fresh.command("off");
  assert.equal(JSON.parse(readFileSync(defaultsPath, "utf8")).enabled, true, "session off must not disable the global default");
  await defaultsCommand.command("default primary,backup");
  const resumedOff = harness(route, fresh.entries); await resumedOff.emit("session_start");
  await resumedOff.command("status");
  assert.match(resumedOff.notices.at(-1), /Failover OFF/);
  assert.match(resumedOff.notices.at(-1), /Providers: fallback → primary → backup/, "saved session choices override global defaults");
  const savedConfig = readFileSync(defaultsPath, "utf8");
  await defaultsCommand.command("default fallback,unknown-provider");
  assert.equal(readFileSync(defaultsPath, "utf8"), savedConfig, "invalid lists must not replace defaults");
  await defaultsCommand.command("default off");
  const freshOff = harness(route); await freshOff.emit("session_start"); await freshOff.end(quota);
  assert.equal(freshOff.switches.length, 0, "default off disables new sessions");
  writeFileSync(defaultsPath, '{"enabled":"yes","providers":[]}');
  const corrupt = harness(route); await corrupt.emit("session_start"); await corrupt.end(quota);
  assert.match(corrupt.notices.at(-1), /Could not read/);
  assert.equal(corrupt.switches.length, 0, "invalid persisted settings must not enable failover");
  rmSync(defaultsPath); mkdirSync(defaultsPath);
  const entryCount = defaultsCommand.entries.length;
  await defaultsCommand.command("default fallback,primary");
  assert.match(defaultsCommand.notices.at(-1), /Could not save/);
  assert.equal(defaultsCommand.entries.length, entryCount, "failed persistence must leave session settings unchanged");
  assert.deepEqual(readdirSync(configDir), ["provider-failover.json"], "failed writes must clean up temporary files");
  rmSync(defaultsPath, { recursive: true });
  console.log("PASS: global defaults, automatic activation in new sessions, session overrides, validation and failed writes");

} finally { Date.now = originalNow; }

// Exercise the actual Pi lifecycle with synthetic providers; no paid model requests.
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(pathToFileURL(join(piDir, "dist/index.js")).href);
const { createAssistantMessageEventStream, InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
const dir = mkdtempSync(join(tmpdir(), "pi-failover-check-"));
let session;
try {
  const packagePath = join(dir, "extensions", "provider-failover");
  mkdirSync(join(dir, "extensions"));
  symlinkSync(fileURLToPath(new URL(".", import.meta.url)), packagePath, "dir");
  const settingsManager = SettingsManager.inMemory({ packages: [packagePath], compaction: { enabled: false }, retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 1, "the package must load one generic failover extension");
  const commandExtensions = loader.getExtensions().extensions.filter((extension) => extension.commands.size > 0);
  assert.equal(commandExtensions.length, 1, "installed package and automatic discovery must not register commands twice");
  assert.deepEqual([...commandExtensions[0].commands.keys()].sort(), ["failover"]);
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: join(dir, "models.json"), modelsStorePath: join(dir, "models-store.json") });
  for (const provider of ["primary", "secondary", "fallback", "backup"]) runtime.registerProvider(provider, { baseUrl: "https://example.invalid/v1", apiKey: "test", api: "test-api", models: [model(provider)] });
  ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel("primary", "test-model"), thinkingLevel: "xhigh", settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), noTools: "all" }));
  const errors = [], requests = [];
  const failing = new Map([["primary", temporary]]);
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
  session.agent.streamFunction = (selected) => {
    const stream = createAssistantMessageEventStream();
    requests.push(selected.provider);
    const error = failing.get(selected.provider);
    const message = { role: "assistant", provider: selected.provider, model: selected.id, api: selected.api, content: error ? [] : [{ type: "text", text: "OK" }], stopReason: error ? "error" : "stop", errorMessage: error, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push(error ? { type: "error", reason: "error", error: message } : { type: "done", reason: "stop", message }); stream.end();
    return stream;
  };
  console.log("PASS: installed package discovery with one generic slash command");
  await session.prompt("/failover default fallback,primary,backup");
  assert.deepEqual(JSON.parse(readFileSync(defaultsPath, "utf8")), { enabled: true, providers: ["fallback", "primary", "backup"] });
  assert.deepEqual(requests, [], "setting defaults must never invoke an LLM");
  await session.prompt("/failover default off");
  await session.prompt("/failover on primary,secondary");
  await session.prompt("Test the provider failover lifecycle.");
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, ["primary", "primary", "primary", "secondary"]);
  assert.equal(session.model.provider, "secondary");
  assert.equal(session.thinkingLevel, "xhigh");
  assert.equal(session.messages.filter((m) => m.role === "user").length, 1, "no duplicate user prompt");
  assert.equal(session.messages.at(-1).content[0].text, "OK");
  requests.length = 0;
  await session.setModel(runtime.getModel("primary", "test-model"));
  settingsManager.applyOverrides({ retry: { enabled: false } });
  await session.prompt("/failover threshold 1");
  await session.prompt("Continue after a failure with core retries disabled.");
  await session.waitForIdle();
  assert.deepEqual(requests, ["primary", "secondary"]);
  assert.equal(session.messages.at(-1).content[0].text, "OK");
  console.log("PASS: real Pi retry/agent_end/model_select/continuation integration; same model and reasoning preserved");
  failing.set("primary", temporary);
  await session.setModel(runtime.getModel("primary", "test-model"));
  await session.prompt("/failover on primary,secondary");
  requests.length = 0;
  await session.prompt("Fail the current provider."); await session.waitForIdle();
  assert.deepEqual(requests, ["primary", "secondary"]);
  assert.equal(session.model.provider, "secondary");
  assert.equal(session.thinkingLevel, "xhigh");
  assert.deepEqual(errors, []);
  console.log("PASS: real Pi retry and provider switching with generic provider IDs");
} finally { Date.now = originalNow; session?.dispose(); rmSync(dir, { recursive: true, force: true }); }
