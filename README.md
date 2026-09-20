# Pi Provider Failover

An optional provider failover extension for [Pi](https://pi.dev). It keeps provider selection generic, preserves the model and reasoning level, and supports cooldown based recovery.

## Install

```text
pi install git:github.com/itsuitsuki/pi-provider-failover
```

Reload the running Pi instance after installation:

```text
/reload
```

Automatic failover is disabled until enabled.

## Commands

Enable a priority order for the current session:

```text
/failover on provider-a,provider-b,provider-c
```

Set the order as the default for every new session:

```text
/failover default provider-a,provider-b,provider-c
```

Inspect or change the default:

```text
/failover default
/failover default off
```

Other commands:

```text
/failover status
/failover off
/failover threshold 3
/failover cooldown 300
```

Provider IDs are read from Pi's model registry. The extension does not register providers or contain provider credentials.

## Routing behavior

Failover keeps the same model ID, context capacity, input capabilities, and reasoning level. Quota exhaustion, an explicitly unavailable model, and an explicit upstream failure switch immediately. Other temporary failures require three consecutive failures by default, including Pi's native retries. Unknown, authentication, context overflow, and cancellation errors do not trigger a switch.

After switching to a lower-priority provider, the extension waits 300 seconds by default before trying a higher-priority provider on the next real request. A failed recovery probe immediately searches the remaining eligible providers. It does not send background requests while idle.

Every failure switch and cooldown recovery is persisted as a `provider-failover-switch` session entry and shown as a warning.

Ordinary failures move down the configured priority order first. After all lower-priority choices are exhausted, the last provider may wrap to a higher-priority provider only when it was not already attempted in the same chain and its cooldown has expired. This prevents an exhausted primary provider from being selected again immediately.

A workflow stops only after every compatible, authenticated, non-cooling provider has been attempted for that continuation.

Workflow extensions can retain ownership of continuation after a successful switch through the synchronous `provider-failover:claim` event. A claimed continuation suppresses the extension's generic follow-up, allowing the workflow to remain active without duplicate prompts.

Global defaults are stored at `~/.pi/agent/provider-failover.json`, or under the directory selected by `PI_CODING_AGENT_DIR`. A setting explicitly saved in an existing session takes precedence over the global default. `/failover off` affects only the current session; `/failover default off` disables automatic failover for new sessions too.

Automatic switching stops when the latest context is an encrypted native compaction checkpoint without a portable summary. Enable native compaction and create a new checkpoint before using failover with that context.

## Test

```sh
node check.mjs
```

The check uses synthetic providers and local mocks. It does not make paid inference requests or access credentials.

An optional integration check can validate cooperation with an installed Goal extension:

```sh
node check-goal.mjs /path/to/goal/dist/index.ts
```
