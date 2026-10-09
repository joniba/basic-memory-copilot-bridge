# Basic Memory Copilot bridge

A Windows-only native Copilot CLI extension that offers intelligent memory
checkpoints in the user's existing interactive session. The upstream Basic
Memory `memory-capture` skill performs any actual writing. The extension
uses native context information, not transcript bytes, and adds no shell
hooks, plugin manifest, custom MCP server, bundled skill, or model client.

## Requirements

- Node.js (tested with 24.16.0), PowerShell 7, and GitHub Copilot CLI.
- A working **local** Basic Memory MCP server available to Copilot.
- The upstream Basic Memory `memory-capture` skill installed and enabled.
- Experimental Copilot CLI extensions enabled with `--experimental`.

Verified against Copilot CLI **1.0.93-2**, PowerShell **7.4.20**, and local
Basic Memory **0.23.2 / MCP API v2**. Dependency checks:

```powershell
node --version
pwsh --version
copilot --version
basic-memory --version
copilot mcp list
copilot skill list --json
```

Also call Basic Memory's `basic_memory_diagnostics` and `search_notes` through
Copilot to verify that the MCP actually responds and the destination project
uses local mode. Listing a configured server alone does not establish health.
The bridge does not install, replace, or reconfigure your MCP server or skill.

## Install or try locally

Download this revision as a ZIP from GitHub and extract it, or use an existing
checkout; cloning is not required. From the extracted repository directory:

```powershell
.\scripts\install-extension.ps1
copilot --experimental
```

The installer copies the three runtime files under `extension\` to
`%USERPROFILE%\.copilot\extensions\basic-memory-bridge` (or `COPILOT_HOME`).
The SDK is supplied by Copilot; no package installation is needed. Checking
out this repository alone does not activate the extension.

**The token status line is optional and is not installed by
`install-extension.ps1`.** To add it, follow
[Optional token status line](#optional-token-status-line) below.

If migrating from `basic-memory-copilot`, close affected CLI sessions, disable
and uninstall that old plugin first, then install the extension and start a
fresh CLI. The installer refuses an enabled old plugin or an existing target
directory rather than silently overwriting it. Do not reinstall the old plugin,
mount an old revision with `--plugin-dir`, or globally reload unrelated
extensions as an activation shortcut.

## Behavior and configuration

| Trigger | Eligibility |
| --- | --- |
| Periodic | 50,000 new native context tokens AND 60 minutes since the previous offer |
| Pressure | At least 65% utilization, ORed with periodic eligibility; a separate 5-minute gap since any offer and one pressure offer per compaction epoch |

There is no cooldown before the first opportunity. Checkpoints are queued
only at a safe, non-aborted root idle. Checkpoint-generated turns cannot
recursively trigger another checkpoint. Missing native readings fail open;
there is no byte fallback. Compaction resets context baselines, and a missed
pre-compaction opportunity does not schedule a recovery capture afterward.
Capture before every compaction is not guaranteed.

Edit the installed `config.json`, not the checkout. Capture and bounded debug
logging are enabled by default. Set `enabled: false` to stop new automatic offers.

## Optional token status line

The token display is a **separate status-line script**, not part of the
long-running BM extension. Installing or reloading that extension does not
enable the display. From the extracted repository directory, run this
additional installer once:

```powershell
.\scripts\install-statusline.ps1
```

It preserves the existing custom renderer and appends the labeled badge:

```text
[existing status] | tokens: 205K (81% - compaction imminent)
```

Without a previous renderer, the output contains only the token badge.
If a renderer is configured, its output is retained without modifying its
code. Extension load order does not affect composition.

Once configured, **Copilot runs the script automatically on status-line
refreshes**. It uses the current native context-token count and selected
context tier's limit, not billed tokens or BM capture state. Missing token
data hides only the badge. No polling, MCP requests, or model calls are added.
The percentage and warning are yellow at **60-69%** (`60% - nearing compaction`)
and red at **70% or more** (`71% - compaction imminent`). Below 60%, the
percentage is uncolored and has no warning. Colors and labels follow the
displayed rounded percentage; the red label is an early warning, not a
guarantee of the CLI's actual compaction timing.

### Already-open CLI sessions

New sessions read the installed command from user settings. An already-open
session may still have the previous command in memory. To reload its live
settings without restarting, enter this at the Copilot prompt:

```text
/settings statusLine.padding 0
```

This sets left padding to zero; if you use custom padding, substitute that
value. Reloading extensions alone does not refresh the status-line command.
Future edits to the installed script or its companion config take effect
on the next status-line refresh without an extension reload.

The companion is installed under
`%USERPROFILE%\.copilot\statusline\context-tokens` (or `COPILOT_HOME`), separately
from the BM extension. Its `config.json` saves the previous renderer and has
`showTokens: true`; set that to `false` to keep only the previous output.
The installer preserves unrelated settings, padding, and refresh interval,
and refuses an existing installation rather than overwriting or nesting it.

See [the status-line guide](STATUSLINE.md) for restoration, formatting, and
failure behavior. This optional component does not change automatic capture.

## Capture identity and privacy

The checkpoint prompt instructs the model to use the existing skill, search
by `metadata_filters.thread_id`, and update the same thread note. It preserves:

```yaml
thread_id: copilot:<sessionId>
copilot_session_id: <sessionId>
captured_from: github-copilot
cwd: <current-working-directory>
repo: <optional-Git-root>
branch: <optional-Git-branch>
```

Available repository context comes from the native session, without spawning
Git. The bridge does not read transcript contents or make independent network
or model calls. Diagnostics omit prompts, tool results, paths, and exception text.

An accepted offer is not a successful note write. The agent may decline, normal
CLI permissions still apply, and model/tool usage is billed normally. Local
storage depends on the configured BM project's routing and model compliance;
the extension does not impose a new project-selection policy.

## Persistent state and recovery

The extension stores metadata and bounded JSONL diagnostics under the Copilot
home, independently of the source checkout:

```text
%USERPROFILE%\.copilot\extension-state\basic-memory-bridge\sessions\<sessionId>.json
%USERPROFILE%\.copilot\extension-state\basic-memory-bridge\logs\<sessionId>.jsonl
```

State tracks accepted opportunities, not successful writes. It survives
restart/resume and excludes checkpoint-turn growth from the next watermark.
Atomic replacement and an exclusive per-session lock protect updates; errors
fail open. A leftover lock requires owner-checked manual recovery, never
automatic age-based removal. See [native extension documentation](NATIVE-EXTENSION.md)
for the complete settings, lifecycle, and recovery behavior.

## Tests

No installation or package restore is required:

```powershell
node --test --test-reporter=spec .\tests\extension.test.mjs
```

Logic tests cover token/interval boundaries, pressure overrides, compaction
epochs, reloads, send acknowledgement, cancellation, concurrency, and privacy.
Fixtures are synthetic and isolated under ignored `.test-artifacts\`.
Production settings are not lowered by tests.

Interactive testing confirmed native usage/idle signals, same-session
follow-up delivery, skill invocation, local BM diagnostics/search, and clean
cancellation without recursion. The fixture write was cancelled; successful
and repeated note writes were explicitly skipped, not reported as passed.
Other unexercised live cases remain distinguished from logic-test coverage.
The previous plugin implementation remains in Git history for rollback.

## API references and compatibility

- [Copilot CLI extensions](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-cli-extensions)
- [Creating an extension](https://docs.github.com/en/copilot/tutorials/create-an-extension)
- [SDK extension lifecycle](https://github.com/github/copilot-sdk/blob/main/nodejs/docs/extensions.md)

Extension APIs are experimental and version-sensitive. This implementation
targets Windows interactive CLI sessions, not VS Code or cloud-agent hooks.
