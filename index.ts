import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE = "provider-failover";
const HELP = "/failover default [provider1,provider2,...|off] | on [provider1,provider2,...] | off | status | threshold 3 | cooldown 300";
type Failure = "quota" | "temporary" | "unavailable" | "upstream";
type Options = { enabled: boolean; providers: string[]; threshold: number; cooldown: number };
const defaults = (): Options => ({ enabled: false, providers: [], threshold: 3, cooldown: 300 });
type Recovery = {
  modelId: string;
  level: ReturnType<ExtensionAPI["getThinkingLevel"]>;
  retryAt: number;
  probe?: string;
  cooldowns?: Record<string, number>;
};
function providerList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  const providers = [...new Set(value.map((item: string) => item.trim()))];
  return providers.length >= 2 && providers.every((provider) => /^[\w.-]+$/.test(provider)) ? providers : undefined;
}

export function classifyFailure(text: string): Failure | undefined {
  // HTTP 403 alone also means permission/auth failures; require an explicit billing reason.
  if (/usage[_ ]limit(?:[_ ]reached| has been reached| reached)|insufficient[_ ](?:quota|credits)|billing_hard_limit_reached|quota[_ ](?:exceeded|exhausted)/i.test(text)) return "quota";
  if (/model[_ ]not[_ -]found|model\s+["'\w.-]+\s+is\s+not\s+available|not available for this (?:group|project|account)/i.test(text)) return "unavailable";
  if (/upstream[_ ]error|upstream request failed/i.test(text)) return "upstream";
  if (/context_length_exceeded|context window|too many tokens|invalid[_ ](?:api[_ ]key|request)|authentication|unauthorized|token is expired|\b(?:401|403|404)\b/i.test(text)) return undefined;
  if (/temporarily unavailable|overloaded|rate[_ -]limit|too many requests|\b(?:429|500|502|503|504|520|522|524)\b|stream_read_error|fetch failed|connection error|ECONNRESET|ETIMEDOUT/i.test(text)) return "temporary";
  return undefined;
}

export function hasUnportableCheckpoint(ctx: ExtensionContext): boolean {
  const entry = ctx.sessionManager.getBranch().findLast((item) => item.type === "compaction");
  if (entry?.type !== "compaction") return false;
  const strategy = (entry.details as { strategy?: string } | undefined)?.strategy;
  return typeof strategy === "string" && strategy.includes("compaction") && !entry.summary?.trim();
}

function compatible(current: Model<Api>, target: Model<Api>, level: ReturnType<ExtensionAPI["getThinkingLevel"]>): boolean {
  return current.id === target.id
    && target.contextWindow >= current.contextWindow
    && current.input.every((input) => target.input.includes(input))
    && getSupportedThinkingLevels(target).includes(level);
}

export default function providerFailover(pi: ExtensionAPI) {
  const configPath = join(getAgentDir(), `${STATE}.json`);
  const loadDefaults = (): Options => {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults();
      throw error;
    }
    if (!value || typeof value !== "object" || !("enabled" in value) || typeof value.enabled !== "boolean" || !("providers" in value)) {
      throw new Error("Invalid failover defaults.");
    }
    const providers = providerList(value.providers);
    if (!providers) throw new Error("Invalid default provider list.");
    return { ...defaults(), enabled: value.enabled, providers };
  };
  const persistDefaults = (next: Options) => {
    const temporary = `${configPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ enabled: next.enabled, providers: next.providers }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temporary, configPath);
    } finally {
      rmSync(temporary, { force: true });
    }
  };
  let options = defaults();
  let generation = 0;
  let switching = false;
  let failures = 0;
  let failureProvider: string | undefined;
  let failureTime = 0;
  let recovery: Recovery | undefined;
  let continuation: { provider: string; modelId: string; generation: number; message: unknown; ctx: ExtensionContext; signal?: AbortSignal } | undefined;
  const attempted = new Set<string>();
  const blockedUntil = new Map<string, number>();

  const reset = () => {
    generation++;
    failures = 0;
    failureProvider = undefined;
    attempted.clear();
    continuation = undefined;
  };
  const status = (ctx: ExtensionContext) => {
    ctx.ui.setStatus(STATE, options.enabled ? `Failover: on · ${options.providers.join(" → ")}` : undefined);
  };
  const saveRecovery = (next: Recovery | undefined) => {
    recovery = next ? { ...next, cooldowns: Object.fromEntries(blockedUntil) } : undefined;
    pi.appendEntry(`${STATE}-recovery`, recovery ?? null);
  };
  const restore = (_event: unknown, ctx: ExtensionContext) => {
    reset();
    blockedUntil.clear();
    try {
      options = loadDefaults();
    } catch {
      options = defaults();
      ctx.ui.notify(`Could not read ${configPath}; using disabled built-in defaults.`, "warning");
    }
    recovery = undefined;
    const entry = ctx.sessionManager.getBranch().findLast((item) => item.type === "custom" && item.customType === STATE);
    const saved = entry?.type === "custom" ? entry.data as Partial<Options> | undefined : undefined;
    if (saved && typeof saved.enabled === "boolean" && Array.isArray(saved.providers)
      && saved.providers.length >= 2 && saved.providers.every((p) => typeof p === "string" && /^[\w.-]+$/.test(p))
      && Number.isInteger(saved.threshold) && saved.threshold! >= 1 && saved.threshold! <= 10
      && Number.isInteger(saved.cooldown) && saved.cooldown! >= 1 && saved.cooldown! <= 86400) {
      options = { ...saved } as Options;
    }
    const recoveryEntry = ctx.sessionManager.getBranch().findLast((item) => item.type === "custom" && item.customType === `${STATE}-recovery`);
    const value = recoveryEntry?.type === "custom" ? recoveryEntry.data as Recovery | undefined : undefined;
    if (value && typeof value.modelId === "string" && Number.isFinite(value.retryAt)
      && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.level)) {
      recovery = { modelId: value.modelId, level: value.level, retryAt: value.retryAt,
        ...(typeof value.probe === "string" && options.providers.includes(value.probe) ? { probe: value.probe } : {}) };
      if (value.cooldowns && typeof value.cooldowns === "object") {
        for (const [provider, until] of Object.entries(value.cooldowns)) {
          if (options.providers.includes(provider) && Number.isFinite(until)) blockedUntil.set(provider, until);
        }
      }
    }
    if (options.enabled && !recoveryEntry && ctx.model && options.providers.indexOf(ctx.model.provider) > 0) {
      saveRecovery({ modelId: ctx.model.id, level: pi.getThinkingLevel(), retryAt: Date.now() + options.cooldown * 1000 });
    }
    status(ctx);
  };
  pi.on("session_start", (event, ctx) => {
    restore(event, ctx);
    if (ctx.hasUI) ctx.ui.notify(`Provider failover loaded: /failover. Automatic failover is ${options.enabled ? "ON" : "OFF"}.`, "info");
  });
  pi.on("session_tree", restore);
  pi.on("session_shutdown", () => { options.enabled = false; reset(); });
  pi.on("model_select", (_event, ctx) => {
    if (!switching) { reset(); if (recovery) saveRecovery(undefined); }
    status(ctx);
  });
  pi.on("input", (event) => {
    if (event.source !== "extension") {
      generation++;
      attempted.clear();
    }
  });
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant" || message.provider !== ctx.model?.provider || message.model !== ctx.model.id
      || message.stopReason === "error" || message.stopReason === "aborted") return;
    reset();
    blockedUntil.delete(message.provider);
    if (recovery) {
      const wasProbe = recovery.probe === message.provider;
      if (options.providers[0] === message.provider) saveRecovery(undefined);
      else if (wasProbe) saveRecovery({ ...recovery, probe: undefined, retryAt: Date.now() + options.cooldown * 1000 });
      if (wasProbe) ctx.ui.notify(`${message.provider} recovered; continuing on this provider.`, "info");
    }
  });

  const retryPreferred = async (ctx: ExtensionContext) => {
    const current = ctx.model;
    if (!options.enabled || switching || !recovery || recovery.probe || !current || Date.now() < recovery.retryAt
      || current.id !== recovery.modelId || ctx.signal?.aborted || hasUnportableCheckpoint(ctx)) return;
    const priority = options.providers.indexOf(current.provider);
    if (priority <= 0) return;
    const available = ctx.modelRegistry.getAvailable();
    const target = options.providers.slice(0, priority).flatMap((provider) => available.filter((model) =>
      model.provider === provider && (blockedUntil.get(provider) ?? 0) <= Date.now()
      && compatible(current, model, recovery!.level)))[0];
    if (!target) return;
    const revision = generation;
    const plan = recovery;
    try {
      // Retry with the next real request; an idle probe would consume provider quota.
      switching = true;
      if (!await pi.setModel(target)) return;
      if (!options.enabled || generation !== revision || ctx.signal?.aborted) return;
      pi.setThinkingLevel(plan.level);
      attempted.delete(target.provider);
      saveRecovery({ ...plan, probe: target.provider });
      pi.appendEntry(`${STATE}-switch`, { from: current.provider, to: target.provider, model: target.id, reason: "recovery" });
      ctx.ui.notify(`Failover: ${current.provider} → ${target.provider}/${target.id} (recovery); continuing with ${plan.level} reasoning.`, "warning");
    } catch {
      blockedUntil.set(target.provider, Date.now() + options.cooldown * 1000);
      if (generation === revision && recovery) saveRecovery({ ...recovery, retryAt: Date.now() + options.cooldown * 1000 });
      ctx.ui.notify(`Could not select ${target.provider} for recovery.`, "warning");
    } finally {
      switching = false;
    }
  };
  pi.on("before_agent_start", async (_event, ctx) => { await retryPreferred(ctx); });
  pi.on("turn_end", async (event, ctx) => {
    if (event.message.role === "assistant" && event.message.stopReason === "toolUse") await retryPreferred(ctx);
  });
  const canContinue = (next: NonNullable<typeof continuation>) => options.enabled && next.generation === generation
    && !next.signal?.aborted && next.ctx.model?.provider === next.provider && next.ctx.model.id === next.modelId;
  // Workflow extensions can take responsibility for one settled continuation.
  // The exact failed message prevents stale or cross-session recovery claims.
  const unsubscribeClaim = pi.events.on("provider-failover:claim", (data) => {
    if (!data || typeof data !== "object" || !("message" in data)) return;
    const next = continuation;
    if (!next || data.message !== next.message || !canContinue(next)) return;
    continuation = undefined;
    (data as { claimed?: boolean }).claimed = true;
  });
  pi.on("session_shutdown", unsubscribeClaim);
  // Let Pi's native retry continue first. Queueing a follow-up before settlement
  // would generate a second response after a successful native retry.
  pi.on("agent_start", () => { continuation = undefined; });
  pi.on("agent_settled", (_event, ctx) => {
    const next = continuation;
    continuation = undefined;
    if (!next || !canContinue(next) || ctx.signal?.aborted || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    pi.sendMessage({
      customType: `${STATE}-continue`,
      content: "The provider was switched after a request failure. Continue the pending task from the existing conversation and completed tool results.",
      display: false,
    }, { triggerTurn: true, deliverAs: "followUp" });
  });

  pi.registerCommand("failover", {
    description: "Opt into provider failover and automatic recovery in provider priority order",
    getArgumentCompletions: (prefix) => ["default", "on", "off", "status", "threshold", "cooldown"]
      .filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const [action = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (action === "default" && rest.length === 0) {
        try {
          const saved = loadDefaults();
          ctx.ui.notify(`New-session default: ${saved.enabled ? "ON" : "OFF"}; ${saved.providers.join(" → ")}\nSaved in ${configPath}\n${HELP}`, "info");
        } catch {
          ctx.ui.notify(`Could not read ${configPath}.`, "error");
        }
        return;
      }
      if (action === "status" && rest.length === 0) {
        const cooling = [...blockedUntil].filter(([, until]) => until > Date.now())
          .map(([provider, until]) => `${provider} ${Math.ceil((until - Date.now()) / 1000)}s`);
        const priority = options.providers.indexOf(ctx.model?.provider ?? "");
        const recoveryStatus = recovery?.probe ? `\nRecovery probe: ${recovery.probe}`
          : recovery && priority > 0 ? `\nAutomatic return: ${options.providers.slice(0, priority).join(" → ")}; next request in ${Math.max(0, Math.ceil((recovery.retryAt - Date.now()) / 1000))}s or later.` : "";
        ctx.ui.notify(`Failover ${options.enabled ? "ON" : "OFF"} (this session)\nProviders: ${options.providers.join(" → ")}\nTemporary error threshold: ${options.threshold}; cooldown: ${options.cooldown}s\nSame model and reasoning level required.${cooling.length ? `\nCooling down: ${cooling.join(", ")}` : ""}${recoveryStatus}\n${HELP}`, "info");
        return;
      }
      if (action === "default" && rest.length === 1 && rest[0] === "off") {
        try {
          const next = { ...options, providers: loadDefaults().providers, enabled: false };
          persistDefaults(next);
          options = next;
        } catch {
          ctx.ui.notify(`Could not save ${configPath}; failover settings were not changed.`, "error");
          return;
        }
      } else if (action === "on" || action === "default") {
        const providers = rest.length ? providerList(rest.join(",").split(",").filter(Boolean)) : options.providers;
        const available = new Set((action === "default" ? ctx.modelRegistry.getAll() : ctx.modelRegistry.getAvailable()).map((model) => model.provider));
        if (!providers || providers.some((provider) => !available.has(provider))) {
          ctx.ui.notify(action === "default" ? "Specify at least two distinct, registered providers from /model." : "Specify at least two distinct, authenticated providers from /model.", "error");
          return;
        }
        const next = { ...options, enabled: true, providers };
        if (action === "default") {
          try {
            persistDefaults(next);
          } catch {
            ctx.ui.notify(`Could not save ${configPath}; failover settings were not changed.`, "error");
            return;
          }
        }
        options = next;
      } else if (action === "off" && rest.length === 0) {
        options.enabled = false;
      } else if ((action === "threshold" || action === "cooldown") && rest.length === 1) {
        const value = Number(rest[0]);
        if (!Number.isInteger(value) || value < 1 || value > (action === "threshold" ? 10 : 86400)) {
          ctx.ui.notify(action === "threshold" ? "Threshold must be an integer from 1 to 10." : "Cooldown must be an integer from 1 to 86400 seconds.", "error");
          return;
        }
        options = { ...options, [action]: value };
      } else {
        ctx.ui.notify(HELP, "info");
        return;
      }
      reset();
      if (!options.enabled) { if (recovery) saveRecovery(undefined); }
      else if ((action === "on" || action === "default") && options.providers.indexOf(ctx.model?.provider ?? "") > 0) {
        saveRecovery({ modelId: ctx.model!.id, level: pi.getThinkingLevel(), retryAt: Date.now() + options.cooldown * 1000 });
      } else if ((action === "on" || action === "default") && recovery) saveRecovery(undefined);
      else if (action === "cooldown" && recovery) {
        const retryAt = Date.now() + options.cooldown * 1000;
        for (const provider of blockedUntil.keys()) blockedUntil.set(provider, retryAt);
        saveRecovery({ ...recovery, retryAt });
      }
      pi.appendEntry(STATE, { ...options, providers: [...options.providers] });
      status(ctx);
      ctx.ui.notify(`Failover ${options.enabled ? "ON" : "OFF"}: ${options.providers.join(" → ")}; threshold ${options.threshold}; cooldown ${options.cooldown}s. ${action === "default" ? "Saved as the default for new sessions and applied to this session." : "Applies to this session."}`, "info");
      if (options.enabled && hasUnportableCheckpoint(ctx)) {
        ctx.ui.notify("Automatic switching is blocked by an encrypted native checkpoint without a portable summary. Enable native compaction before creating a new checkpoint.", "warning");
      }
    },
  });

  // Finish switching before agent_end consumers decide whether a workflow stops.
  pi.on("turn_end", async (event, ctx) => {
    const message = event.message;
    if (!options.enabled || switching || !message || message.role !== "assistant") return;
    const current = ctx.model;
    if (!current || message.provider !== current.provider || message.model !== current.id) return;
    const kind = message.stopReason === "error" ? classifyFailure(message.errorMessage ?? "") : undefined;
    if (!kind || ctx.signal?.aborted) {
      reset();
      return;
    }
    if (!options.providers.includes(current.provider)) return;
    failures = failureProvider === current.provider && Date.now() - failureTime < options.cooldown * 1000 ? failures + 1 : 1;
    failureProvider = current.provider;
    failureTime = Date.now();
    const isRecoveryProbe = recovery?.probe === current.provider;
    if (kind === "temporary" && failures < (isRecoveryProbe ? 1 : options.threshold)) return;
    if (attempted.has(current.provider)) return;
    attempted.add(current.provider);
    blockedUntil.set(current.provider, Date.now() + options.cooldown * 1000);
    if (recovery) saveRecovery({ ...recovery, probe: undefined, retryAt: Date.now() + options.cooldown * 1000 });
    if (hasUnportableCheckpoint(ctx)) {
      ctx.ui.notify("Failover stopped: encrypted native context has no portable summary. Current provider retained.", "warning");
      return;
    }

    const level = pi.getThinkingLevel();
    const revision = generation;
    const priority = options.providers.indexOf(current.provider);
    const available = ctx.modelRegistry.getAvailable();
    const eligible = (provider: string) => available
      .filter((model) => model.provider === provider && provider !== current.provider
        && !attempted.has(provider) && (blockedUntil.get(provider) ?? 0) <= Date.now()
        && compatible(current, model, level));
    const lowerCandidates = options.providers.slice(priority + 1).flatMap(eligible);
    // Only wrap after lower-priority choices are exhausted. Failed providers remain
    // blocked until cooldown, so this cannot immediately bounce back up the chain.
    const candidates = lowerCandidates.length
      ? lowerCandidates
      : options.providers.slice(0, priority).flatMap(eligible);
    for (const target of candidates) {
      if (!options.enabled || generation !== revision || ctx.model !== current || ctx.signal?.aborted) return;
      try {
        switching = true;
        if (!await pi.setModel(target)) continue;
        // /off or user input can arrive while provider authentication is resolving.
        if (!options.enabled || generation !== revision || ctx.signal?.aborted) return;
        pi.setThinkingLevel(level);
        failures = 0;
        failureProvider = undefined;
        if (options.providers.indexOf(target.provider) > 0) {
          saveRecovery({ modelId: current.id, level, retryAt: Date.now() + options.cooldown * 1000 });
        } else if (recovery) saveRecovery(undefined);
        pi.appendEntry(`${STATE}-switch`, { from: current.provider, to: target.provider, model: target.id, reason: kind });
        ctx.ui.notify(`Failover: ${current.provider} → ${target.provider}/${target.id} (${kind}); continuing with ${level} reasoning.`, "warning");
        continuation = { provider: target.provider, modelId: target.id, generation, message, ctx, signal: ctx.signal };
        return;
      } catch {
        ctx.ui.notify(`Failover could not select ${target.provider}/${target.id}. Check its authentication.`, "warning");
        if (ctx.model !== current) return;
      } finally {
        switching = false;
      }
    }
    ctx.ui.notify("Failover stopped: no eligible provider with the same model, context capacity and reasoning level is available. Check /failover status.", "warning");
  });
}
