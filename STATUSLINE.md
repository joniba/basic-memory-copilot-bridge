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

The bridge's examples are:

```text
tokens: 500K (55%) last checkpoint: 455K, next checkpoint: 505K
tokens: 505K (56%) last checkpoint: 455K, next checkpoint: in 12m
tokens: 500K (55%) last checkpoint: 455K, next checkpoint: in progress
tokens: 602K (65% — nearing compaction) last checkpoint: 455K, next checkpoint: queued
tokens: 216K (79% — compaction imminent) last checkpoint: 198K, next checkpoint: compaction expected first
```

Last/next checkpoint text is white; only `queued`/`in progress` is yellow even
when the utilization warning is white or red. Finish, abort or failure replaces the
active contribution with the appropriate hint, independently of the warning. There is no
"next checkpoint now" bridge label; after cooldown the token target is retained.
`last checkpoint: none` means no opportunity yet; `unknown` means an imported
opportunity had no native token position. Known last positions survive compaction
and stay on the previous settled turn while a new checkpoint is queued/running.
The bridge uses native background-compaction metadata for `tokenCeiling`, with the
native context limit as fallback. This is not a hard maximum or a guarantee about
exact compaction timing, and the label does not request immediate post-compaction
capture. Labels describe checkpoint turns, not verified persistence. Publication failures fail open,
and a lease expires instead of leaving a permanent activity indicator.

## Tests

```powershell
node --test --test-reporter=spec .\tests\statusline.test.mjs
```

Tests cover exact label/rounding, native versus billing fields, absent data,
preserved input/output, command failures, recursion, and the Windows installer
preserving unrelated JSONC settings and refusing duplicate installation.
