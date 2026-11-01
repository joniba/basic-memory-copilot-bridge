# Composable context-token status line

This optional companion uses Copilot's native status JSON to append a badge:

```text
[existing status] | tokens: 205K (81% — compaction imminent)
```

It delegates to the previously configured status-line command with the same
stdin and working directory. The compositor does not import or modify the
existing renderer and does not depend on the Basic Memory extension.
There is only one configured compositor, not two extensions competing to
write `statusLine.command`.
Installing the BM extension alone does not install or enable this companion.

## Install

Install/update the standalone companion from a published revision:

```powershell
npx github:joniba/basic-memory-copilot-bridge --update --statusline-only
```

The default npx command installs both this companion and the native bridge;
`--no-statusline` skips this component without disabling an existing install.
From a checkout, restore installer dependencies with `npm install --ignore-scripts`
and run `node .\scripts\install.mjs --update --statusline-only`. The original
`scripts\install-statusline.ps1` remains a dependency-free, create-only alternative.

The installer surgically edits `statusLine.command` in user settings,
preserving unrelated settings (including JSONC comments), padding, and any
existing refresh interval. When unset, it adds a two-second CLI refresh so
countdowns update and expired signals disappear. It refuses settings changed
while installation is in progress. It
installs under `%USERPROFILE%\.copilot\statusline\context-tokens`, honoring
`COPILOT_HOME`, and saves the original status-line configuration in its own
`config.json`. Managed file replacement requires `--update`; changed originals
are backed up and unknown files are not purged. An update recognizes its own
command and keeps its saved renderer config byte-identical, rather than nesting
another compositor. It preserves `showTokens`, padding and explicit refresh;
if another installer changed the active renderer, the newly selected renderer
is composed. Missing, recursive or ambiguous saved wiring fails before changes.
The original renderer's code is never modified. npx's cache is not used as the
installed runtime location.

After installation, Copilot invokes the script automatically on status-line
refreshes. In an already-open session, run `/settings statusLine.padding 0`
to reload the saved command without restarting; substitute your existing
padding value if it is not zero. Reloading extensions is not the same as
reloading this setting.

Edit that installed companion config to set `showTokens: false` and retain
only the previous output. To stop using the compositor entirely, restore the
saved `previousStatusLine.command` in user `settings.json`. CLI 1.0.93-2 can
read this setting but its `copilot config` setter refuses it. If no previous
command was configured, remove only that command setting instead. Installed
files need not be deleted to restore the original setting.

Changes to the companion config are picked up on status-line refresh, without
reloading any extensions. If another installer later replaces
`statusLine.command`, this companion does not fight it or change settings
automatically.

## Meaning and failure isolation

The badge uses `context_window.current_context_tokens` divided by
`context_window.displayed_context_limit` from the CLI 1.0.93-2 payload. This
matches the selected context tier's display denominator, not cumulative
billing tokens, the last API call, or the advertised combined input/output
ceiling. Counts at or above 1,000 round to whole decimal K; the percentage
rounds to a whole number. An overfull context is not silently clamped.
The percentage is white below 60%. At displayed 60-69%, the percentage and
`— nearing compaction` are yellow together inside the parentheses; at 70% or
higher, the percentage and `— compaction imminent` are red together.
Checkpoint information follows the parentheses with a space and remains visible
at every utilization level. A contributed activity replaces the scheduling hint,
not the compaction warning. Token count/parentheses and existing output are unchanged.
Foreground color resets after each colored component.
These display thresholds do not inspect the CLI's compaction scheduler.
`Compaction imminent` is an early-warning label, not a guarantee of actual
compaction timing.

Missing/invalid native counts omit usage and scheduling guesses; previous
output stays. A fresh active contribution can still be shown without tokens.
Setting `showTokens: false` disables the whole appended suffix. The previous command's multiline
and colored output is retained, with the badge appended to its last line.
A failed or two-second timed-out prior command yields the badge by itself
and a fixed stderr diagnostic. No input, paths, commands, error messages, or
secrets are logged. This adds a short renderer subprocess per refresh, but
no background polling, BM state reads, MCP requests, or model calls.

The user's existing renderer remains trusted executable code. Its shell
command runs with the same privileges and inherits the CLI environment,
as it did before. Only install against a known trusted existing command.

## Generic session-scoped contributions

Providers write atomic JSON records under
`<CopilotHome>\statusline\contributions\<sessionId>\<provider>.json`.
The compositor reads at most 32 bounded regular JSON files for the native
`session_id`. It does not inspect provider names to decide behavior. The
version-1 envelope has `version`, `sessionId`, `owner`, `expiresAt` (Unix ms),
and `contribution`; freshness must be bounded to at most two minutes.
A null contribution is a cleared signal. Malformed, cross-session, expired,
oversized or control-bearing records cannot inject a status.

An activity contribution has `kind: "activity"`, `priority` (0-100),
`color` (`white`, `yellow`, `red`), and a plain `label`. An optional plain `prefix`
is rendered white before the colored label. Activity overrides hints, not
utilization warnings; higher priority wins among active contributors.
An unrelated provider can contribute its own label without changing this code.

A hint contribution has `kind: "hint"`, priority/color, `targets` with
`tokens` and `notBefore` (Unix ms), and three templates in `labels`:
`tokens` with `{tokens}`, `time` with `{minutes}`, and `ready` with an optional
`{tokens}` placeholder for the reached target with the earliest time gate.
At every utilization level, it shows the earliest token target while none qualifies; once one
qualifies, it uses the earliest remaining time gate among qualified targets.
Target K values round up rather than implying eligibility prematurely, and
remaining minutes round up. No future hint is fabricated without provider data.
An optional positive `tokenCeiling` requires a `labels.beyond` template.
Unreached targets at or above this planning boundary are excluded; when no
targets remain, `beyond` is shown. The same label is used after crossing the
boundary while waiting for a future time gate. Already-reached, time-eligible
targets remain eligible display choices. This generic boundary has no provider-
specific meaning in the compositor.

An activity or hint may include an optional
`annotation: { text: "integration", color: "yellow" }`. Hint targets may carry
their own annotations: the selected target's annotation is used unless the
contribution supplies one. Text is limited to 40 printable characters and colors
to the existing white/yellow/red palette. The compositor appends white
parentheses with only the annotation text colored, without changing the target
or time calculation. The publisher copies only annotation text/color.

Integration examples:

```text
tokens: 567K (61% — nearing compaction) last checkpoint: 411K, next checkpoint: 580K (integration)
tokens: 567K (61% — nearing compaction) last checkpoint: 411K, next checkpoint: queued (integration)
```

The bridge's other examples are:

```text
tokens: 500K (55%) last checkpoint: 455K, next checkpoint: 505K
tokens: 505K (56%) last checkpoint: 455K, next checkpoint: in 12m
tokens: 505K (56%) last checkpoint: 455K, next checkpoint: awaiting idle
tokens: 500K (55%) last checkpoint: 455K, next checkpoint: in progress
tokens: 602K (65% — nearing compaction) last checkpoint: 455K, next checkpoint: queued
tokens: 216K (79% — compaction imminent) last checkpoint: 198K, next checkpoint: compaction expected first
```

Last/next checkpoint text is white; only `queued`/`in progress` is yellow even
when the utilization warning is white or red. Finish, abort or failure replaces the
active contribution with the appropriate hint, independently of the warning. There is no
"next checkpoint now" bridge label. A reached target with an elapsed cooldown
shows white `next checkpoint: awaiting idle` rather than an already-passed count.
This only describes eligibility; `queued` appears after the SDK accepts a request,
and `in progress` after its correlated turn starts. The capture gate and
safe-idle checks are unchanged.
`last checkpoint: none` means no opportunity yet; `unknown` means an imported
opportunity had no native token position. Known last positions survive compaction
and stay on the previous settled turn while a new checkpoint is queued/running.
The bridge uses native background-compaction metadata for `tokenCeiling`, with the
native context limit as fallback. This is not a hard maximum or a guarantee about
exact compaction timing, and the label does not request immediate post-compaction
capture. Labels describe checkpoint turns, not verified persistence. Publication failures fail open,
and a lease expires instead of leaving a permanent activity indicator.

Post-compaction reading is shown separately from checkpoint creation:
`last checkpoint: 455K, state recovery: awaiting idle` (white), then the same
historical prefix with a yellow `queued`/`in progress` suffix after admission
and correlated start. It does not claim a capture was written or successfully
read. Recovery completion restores the normal checkpoint forecast without
changing the historical last-checkpoint value or opportunity cooldown.

### Publisher I/O recovery and diagnostics

On Windows, each write holds an exclusive named-pipe endpoint derived from the
canonical status-file path. This is an operating-system-owned lock, not a
network service or another MCP server: incoming connections are immediately
closed and no payload is exchanged. Windows releases the endpoint if its owner
exits, even if JavaScript cleanup does not run. Publication therefore cannot be
blocked by the old zero-byte `.json.lock` marker left by an exited process.
Old markers are ignored and left untouched, not deleted or stolen by age.

Live Windows lock contention reports `lock-acquire/EADDRINUSE` and is retried.
Other platforms retain exclusive lock files (`EEXIST`); this change does not
claim crash-safe lock recovery on those platforms or for checkpoint-state and
installer locks. On Windows the publisher also retries sharing/access conflicts
(`EPERM`, `EACCES`, `EBUSY`) while reading the owner record, replacing the JSON file,
or removing its own temporary files. There are at most six attempts with
25, 50, 100, 200 and 400 ms waits: no indefinite retry or stale-lock takeover.
Permanent directory, capacity and invalid-payload errors fail explicitly.
An initial claim records the owner it observed before waiting for the lock;
if another process takes ownership meanwhile, the waiting publisher stops
instead of overwriting the newer signal. The same check protects a heartbeat
retry after a failed first publication.

The JSON envelope, file location, leases and owner handoff checks are unchanged.
Use the normal owning-session reload to replace an old publisher with the new
one; old and new lock protocols must not be run concurrently for the same status
file. Already-running sessions on other status files are unaffected by a disk
update, and must load the new code before gaining the crash-safe lock.

Heartbeat renewal always uses the latest requested status, including an update
that previously failed to reach disk. A failed clear stops renewing old activity,
so the prior lease expires rather than resurrecting an obsolete label.
Successful retries do not produce a bridge timeline failure warning.

The extension-process log records only fixed `event`, allowlisted `operation`
and `code`, `decision` (`recovered`/`failed`), and bounded `attempts`. It never
logs raw exception text, paths or contribution contents. Each failed renewal is
reported once. A recovery record identifies the failure class that was handled;
it does not identify which external process held an incompatible file handle.

## Tests

```powershell
node --test --test-reporter=spec .\tests\statusline.test.mjs
```

Tests cover exact label/rounding, native versus billing fields, absent data,
preserved input/output, command failures, recursion, and the Windows installer
preserving unrelated JSONC settings and refusing duplicate installation.
