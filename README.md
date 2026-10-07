# Basic Memory Copilot bridge

A Windows-only Copilot plugin that occasionally asks the active model to
consider the installed Basic Memory `memory-capture` skill. The hook itself
does no summarization, reads no transcript contents, and calls no model or MCP.
There are no npm dependencies, background processes, or bundled skills.

## Requirements

- Node.js (tested with 24.16.0), PowerShell 7, and GitHub Copilot CLI.
- A working **local** Basic Memory MCP server available to Copilot.
- The upstream Basic Memory `memory-capture` skill installed and enabled.
- Git is optional; outside a repository, captures still work.

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

Run these commands from the directory containing `plugin.json`:

```powershell
# Persistent installation for future Copilot sessions:
copilot plugin install .
copilot plugin list

# Then start a new Copilot session.
copilot
```

Installation caches a copy under Copilot's `installed-plugins` directory.
It enables this plugin for future sessions, not just this repository. Existing
sessions do not acquire these hooks until their configuration is reloaded;
starting a new session is the simplest activation path.

For selective use without a persistent installation:

```powershell
copilot --plugin-dir 'C:\path\to\basic-memory-copilot-bridge'
```

Do not install and mount the same plugin simultaneously. The development
worktree for this POC is
`C:\code\dev\basic-memory-copilot-bridge\worktrees\automatic-memory-capture`.

The `--plugin-dir` path loads files directly. Edit its `config.json` to change
the next hook invocation. A persistent install uses its **cached** `config.json`,
not the source checkout: edit that installed copy, or edit the source and
reinstall deliberately to replace the cached copy. Reinstallation can replace
local edits to the installed copy.

To disable capture without uninstalling, set `"enabled": false` in the active
plugin's `config.json`. A file containing only `{"enabled": false}` is valid.
Alternatively, `copilot plugin disable basic-memory-copilot` disables a
persistent installation for future sessions. No MCP configuration changes or
extension reloads are needed.

## Behavior and configuration

The only hooks are `agentStop` and `preCompact`, configured as version-1
PowerShell commands in `com.github.copilot\hooks\hooks.json`. Node receives
the event name as an argument and the Copilot event JSON on stdin.

1. The first eligible stop establishes the transcript byte baseline and normally
   finishes without another model turn.
2. Later stops offer a checkpoint only when all three normal thresholds pass.
3. `preCompact` records a pending flag and time. The next eligible stop offers a
   checkpoint regardless of size or cooldown, including on the first stop.
4. `stop_hook_active: true` always finishes without another checkpoint. Missing
   or malformed guard fields also fail open.
5. Before returning `{"decision":"block","reason":"..."}`, the hook saves the
   prompt byte count and time and clears the compaction flag. A model deciding
   not to capture still counts as a checkpoint opportunity.

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master capture switch |
| `minimumTranscriptBytes` | `30000` | Minimum total transcript file size |
| `minimumDeltaBytes` | `20000` | Bytes since the previous opportunity, or initial baseline |
| `minimumMinutesBetweenPrompts` | `30` | Cooldown after each offered checkpoint |
| `captureAfterPreCompact` | `true` | Pending compaction bypasses normal thresholds |
| `debugLogging` | `false` | Emit operational gate decisions to stderr |

Missing configuration keys inherit defaults. Invalid configuration, including
unknown keys, disables that invocation with a sanitized diagnostic. The first
opportunity has no cooldown to wait out. On transcript shrinkage, byte baselines
reset to zero so growth can recover; the last prompt time is retained.

**Approved deviation from the original protocol:** the first-stop baseline
avoids counting Copilot startup overhead as new work. In a live fresh session,
the transcript was already **62,724 bytes** after the single response
`SHORT_OK`. The original 30 KB gate caused an unnecessary model turn. Raising
the total threshold alone would not robustly exclude startup overhead across
different configurations. Consequently, even a substantive first turn normally
waits for later work; `preCompact` can still trigger its checkpoint.

The gate is intentionally approximate: transcript bytes include tool results
and other runtime overhead, not just useful work. The active model decides
whether any state deserves preservation. This is not a guarantee of a note,
an on-exit backup, or a capture **before** compaction: `preCompact` is notification
only and the opportunity happens at the next eligible stop, after compaction.

## Capture identity and privacy

The continuation instructs the model to use the existing skill, search with
`metadata_filters.thread_id`, and rewrite the same thread capture. It supplies:

```yaml
thread_id: copilot:<sessionId>
copilot_session_id: <sessionId>
captured_from: github-copilot
cwd: <current-working-directory>
repo: <optional-Git-root>
branch: <optional-Git-branch>
```

The installed skill already supports this metadata and same-thread lookup.
The bridge does not fork or modify it. Repository and branch are obtained only
when a checkpoint will be offered, using two bounded, shell-free Git commands.
No Git remote, credentials, environment contents, or commit contents are read.
Path and branch strings are quoted as data in the continuation.

The hook only stats the **exact transcript path supplied by Copilot**. It never
opens the transcript, searches for other sessions, sends network requests,
persists prompts, or logs content. Diagnostics contain only timestamp, event,
session ID, byte count, and a fixed gate/error code. Error messages and stacks
are deliberately excluded. Copilot may record stderr in its own logs.

The continuation runs through the session's existing Copilot model, so an
offered checkpoint incurs normal model/tool usage. This is not offline
inference. The hook adds no transcript upload or external destination, and
the prompt explicitly prohibits raw transcripts and secrets in captures.
**Local storage depends on the existing MCP project's configuration and model
compliance**; the hook cannot enforce where a separately configured MCP writes.
Keep Basic Memory local, or disable this plugin for sensitive sessions.

## Persistent state and recovery

Copilot supplies `COPILOT_PLUGIN_ROOT` and `COPILOT_PLUGIN_DATA` to plugin hooks.
The latter is the authoritative persistent writable directory; no home path
or installation cache path is hardcoded. Its default location is below
`%USERPROFILE%\.copilot\plugin-data`, or the corresponding `COPILOT_HOME`.
Direct installations/mounts have a source-specific `_direct\<source-id>` child.

The bridge stores:

```text
%COPILOT_PLUGIN_DATA%\sessions\<sha256-of-sessionId>.json
```

The file contains only `sessionId`, `baselineTranscriptBytes`,
`lastObservedTranscriptBytes`, `lastCapturePromptBytes`, `lastCapturePromptAt`,
`preCompactSeen`, and `preCompactAt`. It survives CLI restarts. Changing the
plugin source path may change its data directory and reset its baselines.

Writes use an atomic same-directory replacement. A short-lived exclusive
`.json.lock` serializes same-session invocations; overlap fails open rather
than offering duplicate checkpoints. Each session has independent state.
Corrupt state is recreated, baselined, and allowed to finish without prompting
on that recovery stop. Missing state is treated as a new session.

Missing transcripts, unreadable/unwritable state, missing plugin environment,
invalid stdin/config, and hook timeouts all allow normal Copilot operation.
Git failures simply omit optional provenance. Sanitized failures are logged
even when debug logging is off. If a process is forcibly terminated while
holding its lock, the leftover lock safely disables that session's automation.
After confirming no hook is running, remove only that session's `.json.lock`
to recover. The plugin never steals another invocation's lock.

## Tests

No installation or package restore is required:

```powershell
node --test .\tests\memory-hook.test.mjs
```

The suite covers exact boundaries, baseline behavior, cooldowns, loop prevention,
preCompact, configuration validation, state corruption, missing/unwritable
files, shrinkage, concurrency, privacy, optional Git provenance, and the actual
PowerShell command with spaces, apostrophes, and `$` in the plugin path.
Fixtures are synthetic and isolated below ignored `.test-artifacts\unit-*`.
They are retained for inspection; no user data is deleted by the test runner.

For live acceptance, mount a separate test copy with byte thresholds set to `1`
and cooldown `0`, leaving the real plugin's defaults unchanged. The first stop
should baseline; a second user turn should offer exactly one continuation.
Check both useful work (skill invoked, note created then rewritten with the
same thread ID) and meaningless chatter (no note). Simulate `preCompact` by
piping `{"sessionId":"<test-session-id>"}` to the script with argument
`preCompact` and the test mount's `COPILOT_PLUGIN_DATA`; then resume that test
session and check that the pending flag clears.

Live MCP writes should use one explicitly approved, clearly labeled test note.
Do not use real sensitive work merely to fill a transcript.

## API references and compatibility

- [Copilot plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference)
- [Hook configuration and payloads](https://docs.github.com/en/copilot/reference/hooks-configuration)
- [Creating plugins](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-creating)

The installed CLI's help and shipped `HookType` schema were checked alongside
the current official references, then plugin discovery and command execution
were exercised in the installed runtime. The packaged README was absent;
`copilot help hooks` and `copilot help plugins` are not valid help topics in
this build. `copilot plugin --help` is valid.

Agent Plugins 1.0 requires the canonical `$schema` and namespace-specific hook
location used here. Native camelCase hooks deliver `sessionId`, `transcriptPath`,
and `cwd`, but **`stop_hook_active` stays snake_case**. The native payload has
no event discriminator, so the hook command passes it explicitly. Output is
one JSON object on stdout; diagnostics go to stderr. Only top-level
`agentStop` is registered, never `subagentStop`. This POC intentionally does not
provide Linux/macOS, VS Code `Stop` payload, or cloud-agent execution support.
