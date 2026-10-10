# Basic Memory Copilot bridge

A native Copilot CLI extension, validated on Windows, that offers intelligent memory
checkpoints in the user's existing interactive session. The upstream Basic
Memory `memory-capture` skill performs any actual writing. The extension
uses native context information, not transcript bytes, and adds no shell
hooks, plugin manifest, custom MCP server, bundled skill, or model client.

## Requirements

- Node.js 20 or newer (tested with 24.16.0), Git, and GitHub Copilot CLI.
- PowerShell 7 only when using the legacy PowerShell installation commands.
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

## Install or update with npx

From a published revision, install or update in one command without maintaining
a source checkout:

```powershell
npx github:joniba/basic-memory-copilot-bridge --update
```

The package has an npm executable entry and a strict asset allowlist. npm may
ask permission to fetch the GitHub package. `--update` separately authorizes
replacement of this project's managed runtime files and status-line wiring;
without it, identical installs are a no-op and changed existing files are refused.
Changed originals are backed up under
`<CopilotHome>\installation-backups\basic-memory-bridge`.
An exclusive installation lock prevents competing installer writes; a leftover
lock requires owner inspection, not automatic removal.

The default npx command installs **both** the native extension and composing
status-line companion. It preserves existing capture config, saved renderer
preferences, checkpoint state, MCP configuration, skills and unrelated settings.
Code is replaced atomically without purging unknown files. The executable and
renderer paths point into the persistent Copilot home, not npm's temporary cache.
The installer does not launch Copilot, reload extensions, or configure Basic Memory.
Native runtime code remains dependency-free apart from the SDK supplied by Copilot;
the installer alone uses a JSONC parser.

```powershell
# Native extension only; an existing companion is left untouched:
npx github:joniba/basic-memory-copilot-bridge --update --no-statusline

# Independent token/status companion only:
npx github:joniba/basic-memory-copilot-bridge --update --statusline-only
```

Use `--copilot-home` with an absolute path to select another destination;
otherwise `COPILOT_HOME`, then the user's `.copilot` directory, is used.
The installer refuses symlinked managed paths and ambiguous existing compositor
wiring rather than risking a recursive wrapper or overwriting another location.
It never logs the saved previous command.

### Share a feature branch or pinned revision

npm Git selectors make published in-progress features installable without a clone:

```powershell
npx "github:joniba/basic-memory-copilot-bridge#feature/npx-installation" --update
```

For reproducible testing, prefer an exact published commit over a moving branch:

```powershell
$repo = 'github:joniba/basic-memory-copilot-bridge'
$revision = '<full-commit-sha>'
npx "$repo#$revision" --update
```

Only published refs can be fetched from GitHub. npm can cache Git package
resolutions, so pin the requested commit when exchanging a specific candidate.
This package is distributed from GitHub, not published to the npm registry.

### From a checkout or extracted ZIP

```powershell
npm install --ignore-scripts
node .\scripts\install.mjs --update
```

The original dependency-free PowerShell commands remain **create-only**:

```powershell
.\scripts\install-extension.ps1
.\scripts\install-statusline.ps1
```

Those commands still refuse an existing destination. The native-only PowerShell
command does not install the optional companion; use npx or the Node installer
for safe in-place updates. Checking out source alone does not activate it.
For component locations, see [the native guide](NATIVE-EXTENSION.md) and
[the status-line guide](STATUSLINE.md).

If migrating from `basic-memory-copilot`, close affected CLI sessions, disable
and uninstall that old plugin first, then install the extension and start a
fresh CLI. The installer refuses an enabled old plugin or an existing target
directory in create-only mode rather than silently overwriting it. Do not reinstall the old plugin,
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
enable the display. The default npx installer handles both independently; a
native-only install does not enable the companion. To install/update it separately:

```powershell
npx github:joniba/basic-memory-copilot-bridge --update --statusline-only
```

It preserves the existing custom renderer and appends the labeled badge:

```text
[existing status] | tokens: 205K (81% — compaction imminent)
```

Without a previous renderer, the output contains only the token badge.
If a renderer is configured, its output is retained without modifying its
code. Extension load order does not affect composition.

Once configured, **Copilot runs the script automatically on status-line
refreshes**. It uses the current native context-token count and selected
context tier's limit, not billed tokens or BM capture state. Missing token
data hides the token count rather than inventing usage. No MCP requests or
model calls are added. Compaction and checkpoint information are independent:

| State | Inside parentheses | Checkpoint information outside parentheses |
| --- | --- | --- |
| Below 60% | White percentage | White `last checkpoint: 455K, next checkpoint: 505K`, when valid bridge data is available |
| 60-69% | Yellow percentage and `— nearing compaction` | White last/next checkpoint information remains visible |
| 70%+ | Red percentage and `— compaction imminent` | White last/next checkpoint information remains visible |
| Checkpoint queued or started | Normal utilization warning, still visible | White last/next prefix, with only `queued` or `in progress` yellow |

The em dash belongs inside the percentage parentheses. Checkpoint information
follows the closing parenthesis with a space. Active status replaces only the
next-checkpoint forecast, not the compaction warning or previous checkpoint:
`last checkpoint: 455K, next checkpoint: in progress`.
The next target is the earliest remaining periodic or pressure token trigger.
Once its tokens qualify but its cooldown remains, the label becomes
`last checkpoint: 455K, next checkpoint: in 12m`. Once the cooldown expires,
the token target returns until a checkpoint is actually accepted; there is
no "next checkpoint now" label. Last checkpoint means the native context-token
position of the last settled accepted checkpoint turn, not a verified note write.
It does not advance while a new turn is merely queued or running, and survives
compaction separately from eligibility
watermarks. Before any checkpoint it is `none`; an imported opportunity without
a known token position is `unknown`. When remaining token targets lie at or beyond
the native background-compaction boundary, the forecast says
`next checkpoint: compaction expected first`, rather than advertising a target
that is unlikely to be reached. The same applies if that boundary is already
crossed while cooldown remains. This boundary comes from native context metadata,
not the 60/70% display colors; if unavailable, the native context limit is used.
Background compaction is asynchronous, so this is an expectation, not a hard cap
or a promise of immediate capture afterward. Normal eligibility is recalculated
after compaction without changing capture gates.

The bridge emits one normal timeline notice per accepted request:
`[basic-memory-bridge] Memory checkpoint queued`.
A system-origin checkpoint prompt itself may be hidden by the CLI despite
`displayPrompt`; this notice explains the resulting activity. Queued/start/clear
status transitions remain in the status line without requested, started, finished,
or routine cancellation chatter. Warnings retain the extension prefix.
Neither the queued notice nor an in-progress label proves a note was saved.
Colors follow displayed rounded utilization, and compaction labels are
early warnings rather than guarantees of actual scheduler timing.

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
The installer preserves unrelated settings, padding, and an existing refresh
interval; when no interval is set, it adds a two-second status-line refresh.
This updates countdowns and expires stale activity without extra model calls.
Updates recognize their own installed command and retain the saved original
renderer instead of wrapping the compositor again. If another installer has
changed the active renderer, an authorized update composes that current renderer
and preserves `showTokens`. Missing or recursive saved config is rejected.
The legacy PowerShell command remains create-only.

See [the status-line guide](STATUSLINE.md) for restoration, formatting, and
failure behavior. This optional component does not change automatic capture.

### State-file preservation versus runtime reconciliation

The updater leaves checkpoint state files byte-identical and never reloads a
running session automatically. The native bridge separately reconciles context
when it is attached/reloaded. Its existing policy rebases periodic watermarks
when a native token total decreases, even if the successful compaction count is
unchanged. That can discard accrued periodic growth and move the displayed
target; retaining state files is not a guarantee of an identical forecast after
reload. This packaging change does not alter that runtime policy or the capture
thresholds. Opportunity timestamps and actual epoch/reset rules remain intact.

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
