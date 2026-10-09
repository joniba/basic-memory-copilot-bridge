# Native Basic Memory bridge

The extension under `extension\` joins the existing interactive Copilot CLI
session using its bundled SDK. It adds no tools, shell hooks, MCP server,
custom skill, or independent model client. It is not activated by checking
out this repository. Native SDK types and interactive delivery were checked
against CLI 1.0.93-2. The shell-hook plugin is retired; its source remains
available in Git history.

## Install without dual-running

The upstream `memory-capture` skill and local Basic Memory MCP must already
be available independently.

```powershell
# Only for existing legacy installs; close affected CLI sessions first:
copilot plugin disable basic-memory-copilot
copilot plugin uninstall basic-memory-copilot

# From the extracted repository directory:
.\scripts\install-extension.ps1
copilot --experimental
```

Installation copies the four runtime files into
`%USERPROFILE%\.copilot\extensions\basic-memory-bridge` (or `COPILOT_HOME`).
It refuses an enabled old plugin or an existing destination instead of
overwriting another installation. Do not globally reload unrelated extensions
to activate this bridge. A new process is the controlled activation path.
The old plugin's scripts, manifest, config, and tests are no longer shipped.

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

`source: system`, `mode: enqueue` starts a normal agent turn; normal
model/tool costs and permission behavior still apply. The agent invokes the
existing skill if useful and may decline to write. The prompt preserves
`thread_id: copilot:<sessionId>` and available native repository context.
It does not impose a new Basic Memory project-routing policy.
Some CLI versions hide system-origin prompts even when `displayPrompt` is set.
The extension therefore emits one attributed timeline notice using `session.log`:
`[basic-memory-bridge] Memory checkpoint queued`, after SDK acceptance.
Started/finished/cancelled transitions update the status line without additional
routine notices. The notice describes the checkpoint turn, not a verified note
write. All extension timeline warnings also use this prefix; notice failures fail open.
Reservations are not counted as opportunities until the SDK accepts the send.
One-shot `-p` mode can terminate during idle follow-up delivery; it is not a
substitute for testing a long-running interactive session.

## State, diagnostics, and disable

Per-session files live under the Copilot home:

```text
extension-state\basic-memory-bridge\sessions\<sessionId>.json
extension-state\basic-memory-bridge\logs\<sessionId>.jsonl
```

State records opportunities, not successful writes. It survives resume/reload,
reconciles in-flight requests, and excludes checkpoint-turn growth from the
next periodic watermark. At first cutover, an existing plugin opportunity time
for the same session is imported to preserve cooldown; byte watermarks are
never interpreted as tokens. A short-lived exclusive lock and atomic replacement
protect each state file; a leftover lock fails open and requires owner-checked
manual recovery rather than automatic age-based removal.

Diagnostics contain only timestamp, session ID, event, ratio, and fixed
decision codes. Repeated identical decisions are limited to once per minute;
each session log stops growing at 1 MiB. No prompts, transcript contents,
tool results, paths, or exception text are logged. Errors produce a bounded
timeline warning. Set `enabled: false` to stop new automatic opportunities.

## Status-line contribution

The bridge publishes a bounded local snapshot at
`%USERPROFILE%\.copilot\statusline\contributions\<sessionId>\basic-memory-bridge.json`.
This is a generic display contract, separate from internal capture state.
It contains an active label or token/time hint, color, priority, and expiry,
without prompts, tool contents, paths, or error text. Atomic publication and a
30-second lease, renewed every ten seconds, prevent stale activity after a
process exits; a superseded process cannot clear the newer owner's signal.

The optional compositor reads generic contributions for its own session ID,
without importing BM code or parsing the bridge's state schema. Compaction warnings
remain inside the colored percentage parentheses; checkpoint information stays
separate at every utilization level. The last/next prefix is white, and only
the active `queued`/`in progress` suffix is yellow. Idle hints use the
earliest remaining token threshold alongside the last checkpoint's token position,
then a countdown once tokens qualify. The token target returns after the cooldown,
not a "next checkpoint now" label. Last checkpoint history survives context
rebasing/compaction and advances only when an accepted turn settles, not when
it is merely accepted and not as proof of a saved note. Forecasts use the native
`contextInfo.compactionThreshold` as a planning boundary, or the native context
limit when that optional metadata is unavailable. Targets not yet reached at or
beyond the boundary yield `compaction expected first`; crossing that boundary
while cooldown remains does the same. This is a background-start threshold, not
a hard maximum. Compaction still recalculates normal eligibility, not an immediate
recovery capture.
A pressure offer resets periodic time and the post-checkpoint token watermark,
as in the original gate. Expired/invalid/disabled contributions are ignored.
See [the status-line guide](STATUSLINE.md) for the independent render contract.

## Logic tests

```powershell
node --test --test-reporter=spec .\tests\extension.test.mjs
```

Production thresholds are unchanged by tests. Live Windows checks must also
prove same-visible-session delivery, actual local BM writes and same-note
updates, pressure/missed-compaction behavior, and resume/clear/concurrency.

Interactive smoke testing confirmed a same-session pressure follow-up,
`memory-capture` invocation, and successful local BM diagnostics/search.
The user cancelled the write request: no note was created, in-flight state
cleared, and no recursive checkpoint followed. Successful/repeated fixture
writes were explicitly skipped at the user's request. Remaining unexercised
live cases are not implied by logic-test coverage.

Fresh isolated CLI homes can re-run Windows Terminal keybinding setup.
Preserve the existing `askedSetupTerminals` machine-setup observation in the
test home's config to avoid repeating it; do not copy credentials or change
Terminal settings/permissions. A transient MCP handshake failure in this
smoke run retried and recovered before the extension joined; its root cause
is not established.
