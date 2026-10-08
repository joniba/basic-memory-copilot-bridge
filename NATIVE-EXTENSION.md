# Native Basic Memory bridge

The candidate under `extension\` joins the existing interactive Copilot CLI
session using its bundled SDK. It adds no tools, shell hooks, MCP server,
custom skill, or independent model client. It is not activated by checking
out this repository. Native SDK types were checked against CLI 1.0.93-2;
live acceptance is required before retiring the old plugin.

## Install without dual-running

The upstream `memory-capture` skill and local Basic Memory MCP must already
be available independently.

```powershell
copilot plugin disable basic-memory-copilot
# Restart affected running CLI sessions and verify old capture hooks are inactive.
.\scripts\install-extension.ps1
copilot --experimental
```

Installation copies the three runtime files into
`%USERPROFILE%\.copilot\extensions\basic-memory-bridge` (or `COPILOT_HOME`).
It refuses an enabled old plugin or an existing destination instead of
overwriting another installation. Do not globally reload unrelated extensions
to activate this bridge. A new process is the controlled activation path.

## Settings and behavior

Edit the installed `config.json`; it is read on events without reinstalling.

| Setting | Default |
| --- | --- |
| `enabled` | `true` |
| `periodicMinimumNewTokens` | `50000` |
| `minimumMinutesBetweenOpportunities` | `60` |
| `contextPressureThreshold` | `0.65` |
| `pressureMinimumMinutesBetweenOpportunities` | `5` |
| `debugLogging` | `true` |

Periodic eligibility requires native context growth AND the one-hour interval.
There is no interval to wait before the first opportunity. Pressure eligibility
is ORed with periodic eligibility; it uses only the five-minute gap since any
offer and a once-per-compaction-epoch guard. Capture is queued only at a
non-aborted root `session.idle`, with no other active or queued work.

Usage comes from `session.usage_info` and the on-demand native context-info RPC.
Missing or failed native readings skip capture; there is no byte fallback.
Compaction resets token baselines, not the last-offer time. Compaction beginning
before a safe checkpoint is logged as missed; no recovery capture is scheduled
afterward. An already queued, unstarted bridge message is cancelled if it can
still be identified. A running agent turn is never aborted by this extension.
An idle checkpoint is best-effort, not a guarantee against context loss.

`source: system`, `mode: enqueue` starts a normal visible agent turn; normal
model/tool costs and permission behavior still apply. The agent invokes the
existing skill if useful and may decline to write. The prompt preserves
`thread_id: copilot:<sessionId>` and available native repository context.
It does not impose a new Basic Memory project-routing policy.

## State, diagnostics, and disable

Per-session files live under the Copilot home:

```text
extension-state\basic-memory-bridge\sessions\<sessionId>.json
extension-state\basic-memory-bridge\logs\<sessionId>.jsonl
```

State records opportunities, not successful writes. It survives resume/reload,
reconciles in-flight requests, and excludes checkpoint-turn growth from the
next periodic watermark. A short-lived exclusive lock and atomic replacement
protect each state file; a leftover lock fails open and requires owner-checked
manual recovery rather than automatic age-based removal.

Diagnostics contain only timestamp, session ID, event, ratio, and fixed
decision codes. Repeated identical decisions are limited to once per minute;
each session log stops growing at 1 MiB. No prompts, transcript contents,
tool results, paths, or exception text are logged. Errors produce a bounded
timeline warning. Set `enabled: false` to stop new automatic opportunities.

## Logic tests

```powershell
node --test --test-reporter=spec .\tests\extension.test.mjs
```

Production thresholds are unchanged by tests. Live Windows checks must also
prove same-visible-session delivery, actual local BM writes and same-note
updates, pressure/missed-compaction behavior, and resume/clear/concurrency.
