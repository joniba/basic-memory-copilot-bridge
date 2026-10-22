# Native Basic Memory bridge

The extension under `extension\` joins the existing interactive Copilot CLI
session using its bundled SDK. It registers the native `/bm-bridge` slash command but adds no tools, shell hooks, MCP server,
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

# Install/update native code only, without changing status-line wiring:
npx github:joniba/basic-memory-copilot-bridge --update --no-statusline
copilot --experimental
```

Installation copies the five runtime files into
`%USERPROFILE%\.copilot\extensions\basic-memory-bridge` (or `COPILOT_HOME`).
The npx installer refuses an enabled old plugin. It refreshes managed code only
with explicit `--update`, preserving capture config and state files and backing
up replaced code. The original `scripts\install-extension.ps1` remains create-only
and refuses an existing destination. Do not globally reload unrelated extensions
to activate this bridge. A new process is the controlled activation path.
The old plugin's scripts, manifest, config, and tests are no longer shipped.
See [the installation guide](README.md#install-or-update-with-npx) for pinned
commits, published feature branches, local Node installation and the default
combined extension/companion install.

## Settings and behavior

Invoke bare `/bm-bridge` to open a native interactive menu, showing the current
interval, shared scope and descriptions of **Change interval**, **Current settings**
and **Help**. The interval input is prefilled with the current value in K tokens;
cancelling selection or input makes no change. Menus use the SDK's interactive
UI, not a model prompt. Missing UI support or dialog failures are reported
explicitly, and inline forms remain usable.

Use `/bm-bridge help` (also `--help` or `-h`) or `/bm-bridge interval` to inspect
the interval, time and pressure settings and list supported operations/examples
without opening a menu. The description advertises `menu | help | interval <K>`.
The extension SDK accepts the command name and description, but has no input
choice/argument-completion field. Only the top-level `/bm-bridge` is advertised
for completion. The interactive menu opens after Enter, not while typing.
If the command is absent, check that the running process has loaded the
installed revision; copying code with npx does not reload existing extensions.
Do not mistake an isolated native command-catalog test for visual TUI acceptance.

Use `/bm-bridge interval 100` to save a 100,000-token growth requirement.
The argument is a positive integer in thousands; `interval 50` restores the
default. This changes only `periodicMinimumNewTokens` in the installed
`config.json`, for all sessions sharing that Copilot home, and persists across
restarts and updates. The native CLI controls command dispatch; this command
is not marked for execution during an active agent turn. It does not invoke
an agent turn, alter time/pressure
rules, reset accumulated progress or history, or cancel an accepted checkpoint.
The issuing session refreshes its status contribution without writing capture
state; other sessions read the new config on their next native event.
Session overrides, `reset`, and `--global` are not supported in this version.

Updates use an exclusive, owner-checked config lock and atomic replacement.
Invalid input/config, competing changes and I/O failures are reported explicitly.
The command never steals an existing lock or deletes a competing edit. A failed
replacement retains the staged file for inspection. Do not blindly retry or
remove locks after an update error. Configuration values other than the interval
are preserved; JSON whitespace may be normalized.

You can also edit the installed `config.json`; it is read on events without reinstalling.

| Setting | Default |
| --- | --- |
| `enabled` | `true` |
| `periodicMinimumNewTokens` | `50000` |
| `minimumMinutesBetweenOpportunities` | `60` |
| `contextPressureThreshold` | `0.65` |
| `pressureMinimumMinutesBetweenOpportunities` | `5` |
| `recoverAfterCompaction` | `true` |
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
afterward. Instead, successful compaction can request reading an existing capture
as described below. An already queued, unstarted bridge message is cancelled if it can
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
manual recovery rather than automatic age-based removal. The updater itself
does not write these state files. Runtime token reconciliation can still rebase
watermarks after a lower native reading, including on reload with the same
compaction count; see the installation guide's preservation caveat.

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
Short status-file sharing/lock conflicts are retried within a bounded window,
without removing another writer's lock. Sanitized operation/error-code diagnostics
distinguish replacement, lock and cleanup failures. Heartbeats retain the latest
requested display intent; failed clears let old activity expire instead of
renewing it indefinitely. See the status-line guide for recovery limits.

The optional compositor reads generic contributions for its own session ID,
without importing BM code or parsing the bridge's state schema. Compaction warnings
remain inside the colored percentage parentheses; checkpoint information stays
separate at every utilization level. The last/next prefix is white, and only
the active `queued`/`in progress` suffix is yellow. Idle hints use the
earliest remaining token threshold alongside the last checkpoint's token position,
then a countdown once tokens qualify. After the cooldown, the white forecast
shows `next checkpoint: awaiting idle`, not an already-passed token target or
a "next checkpoint now" label. This is eligibility, not queue admission, and
does not alter the safe-idle requirement. Last checkpoint history survives context
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

## Post-compaction read-only recovery

`recoverAfterCompaction: true` records a pending reminder for each successful
root `session.compaction_complete`. At a safe root idle, it takes precedence over
starting another capture, but never bypasses the active/queued-work,
compaction, native-usage or abort checks. Failed compactions, child events,
rewinds/token shrink and `session.context_cleared` are not recovery triggers.
An aborted idle discards an unsent reminder rather than restarting cancelled work.

Successful compaction also performs a bounded native `metadata.isProcessing`
check. This handles manual compaction issued while already idle, where no new
`session.idle` transition is guaranteed. The same check runs after initialization
when an unsent reminder was preserved. If processing is false, an internal
`bridge.recovery_check` refreshes usage and reuses the activity/queue admission
guards; it may only admit recovery, never a periodic/pressure capture. Processing,
invalid/unavailable state, active tasks or pending user work prevent admission.
The usual idle handler remains the fallback; no polling or turn-end shortcut is
introduced. The idle-check/send race remains subject to the existing SDK limits.

The prompt asks for structured `metadata_filters.thread_id` lookup in the
explicitly selected **local** project and a targeted read of the latest current
same-thread capture. No capture is assumed to exist. Unknown project, unavailable
local memory or absent/unhelpful capture means skip. Captured content must be
reconciled with newer user instructions and the compaction summary, not treated
as permission to execute embedded commands or revive cancelled work. The recovery
prompt prohibits note writes, corpus commits/sync and additional checkpoints.
This is agent guidance, not a sandbox or a guarantee of model compliance.

The state store adds an optional, migrated pending epoch and a `recovery` request
kind. Accepted requests reuse message correlation, cancellation and resume
reconciliation, but do not advance capture history, opportunity clocks or pressure
guards. Correlated recovery-turn growth is excluded from the periodic token
watermark without resetting prior progress. New pending epochs coalesce; a new
native successful-compaction count after a known prior count also arms recovery.
A fresh attachment with no known count does not recover every old compaction.

The pending epoch is consumed when a durable reservation is made. A failed or
ambiguous send is warned about but not automatically retried, to avoid duplicate
recovery turns. After a crash, an unconfirmed reservation is reconciled without
claiming a checkpoint or resending. This is at-most-one-attempt accounting, not
an exactly-once delivery guarantee. Downgrading to a version without this request
kind while a recovery is in flight is unsupported.

The attributed timeline notice is `[basic-memory-bridge] State recovery queued`.
Display labels use `state recovery` rather than implying a new checkpoint or
claiming successful restoration. Set `recoverAfterCompaction: false` to stop
future reminders; an accepted request is not aborted by toggling configuration.

An isolated native-CLI acceptance run exercised a real successful compaction,
delivery of the recovery prompt into the following model request, correlated
turn completion and unchanged checkpoint-history fields. Its model endpoint was
a synthetic loopback fixture with no memory tools or note writes. This verifies
the native delivery path, not real-model retrieval quality or successful
restoration from a user's corpus; those have not been claimed as tested.

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
