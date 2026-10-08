# Composable context-token status line

This optional companion uses Copilot's native status JSON to append a badge:

```text
[existing status] | tokens: 205K (81%)
```

It delegates to the previously configured status-line command with the same
stdin and working directory. The compositor does not import or modify the
existing renderer and does not depend on the Basic Memory extension.
There is only one configured compositor, not two extensions competing to
write `statusLine.command`.
Installing the BM extension alone does not install or enable this companion.

## Install

From an extracted revision or existing checkout:

```powershell
.\scripts\install-statusline.ps1
```

The installer surgically edits only `statusLine.command` in user settings,
preserving unrelated settings (including JSONC comments), padding, and refresh
interval. It refuses settings changed while installation is in progress. It
installs under `%USERPROFILE%\.copilot\statusline\context-tokens`, honoring
`COPILOT_HOME`, and saves the original status-line configuration in its own
`config.json`. It refuses an existing destination rather than overwriting or
nesting another compositor. It does not modify the original renderer.

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

Missing/invalid native counts omit **only** the badge; previous output stays.
The same applies when `showTokens` is false. The previous command's multiline
and colored output is retained, with the badge appended to its last line.
A failed or two-second timed-out prior command yields the badge by itself
and a fixed stderr diagnostic. No input, paths, commands, error messages, or
secrets are logged. This adds a short renderer subprocess per refresh, but
no background polling, BM state reads, MCP requests, or model calls.

The user's existing renderer remains trusted executable code. Its shell
command runs with the same privileges and inherits the CLI environment,
as it did before. Only install against a known trusted existing command.

## Tests

```powershell
node --test --test-reporter=spec .\tests\statusline.test.mjs
```

Tests cover exact label/rounding, native versus billing fields, absent data,
preserved input/output, command failures, recursion, and the Windows installer
preserving unrelated JSONC settings and refusing duplicate installation.
