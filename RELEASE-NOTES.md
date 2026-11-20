# Release notes

## Feature candidate: pressure escalation

Branch: `feature/pressure-escalation`. Not installed or merged to main.

- Add square-bracket automation headers distinguishing standard interval,
  pressure and emergency checkpoint prompts.
- Ask the agent to resume its previous unfinished task after capture or a
  decision to skip, respecting newer instructions and explicit stop/cancel.
- After a normally finished 65% checkpoint, permit one additional idle-only
  checkpoint at 75%, retaining the pressure gap.
- If that normal checkpoint has not happened and none is running, steer once
  at 70%. Native delivery, not note quality or completion, suppresses 75%
  interruption on this path.
- At 75% without that delivery, or an initial jump to 75%, permit one emergency
  interruption/poke. Protect running checkpoints and keep unrelated queued
  work by skipping aggressive cancellation when it is present.
- Show a visible skip warning suggesting that the user pause pending work and
  request memory-capture manually. No queue restore controller or watcher.
- Keep bounded stage/delivery/interruption diagnostics and persisted per-cycle
  bookkeeping. No growth gate, capture verification, task reasoning, completion
  acknowledgement, polling or agent-task deadline was added.

Native cancellation can clear pending messages. The single queue snapshot is
not atomic with cancellation; a message arriving in between can still be lost.
Interruption is not exact pause/resume and can race compaction/tool completion.

All **256 regression tests passed**. Isolated native tests verified missing-delivery interruption, suppression after
actual receipt and guarded queue preservation with a visible warning. They used
virtual pressure and a synthetic model, not working-session interruption,
production corpus writes or proof of exact resumption.

```powershell
npx --yes "github:joniba/basic-memory-copilot-bridge#feature/pressure-escalation" --update
```

## 2026-11-19: Bridge stabilization

Branch: `fix/event-only-compaction`.
This cumulative release includes the following fixes beyond `main` at `d0ce17d`.

### Fixes included

- **Restore startup and checkpoint visibility.** Remove the session-type gate
  that rejected sessions based on a client telemetry name. No client-name
  allowlist or runtime-location rejection remains. Successful attachment can
  again publish last/next checkpoint information and enable automatic capture.
- **Remove the failing attribution dependency.** Startup no longer requests
  `getContextAttribution()` or obtains compaction history from it. Existing
  successful-compaction events and saved per-session state drive recovery.
  No replacement API, polling, or history scan was added.
- **Recover after compaction that finishes while already idle.** The preserved
  already-idle fix admits pending recovery through the existing native
  processing/activity/queue checks, without requiring another user prompt or
  another idle notification. It does not recursively start ordinary captures.
- **Prevent abandoned Windows status locks from blocking later publishers.**
  The preserved crash-safe publisher uses an OS-owned named-pipe lock that is
  released when its process exits. Old lock-marker files are ignored, not
  deleted. Atomic status replacement, bounded retries and owner protection
  remain intact.
- **Identify bridge failures without exposing private contents.** The preserved
  diagnostics fix reports the failing operation, safe error code/type and
  startup-versus-event phase. If its normal log cannot be written, sanitized
  evidence falls back to the extension-process log.
- **Make compaction decisions verifiable in logs.** Startup records
  `trackingMode: events-only`. After state is persisted, fixed decision labels
  distinguish successful compaction, failure, context clearing and ignored
  duplicates, with the saved cycle and pending-recovery flag. Distinct cycle
  changes remain visible within one minute; repeated identical records are
  throttled. Existing one-MiB per-session log limits remain.

### Preserved behavior and limits

Capture thresholds, cooldowns, saved checkpoint history and existing
pending/in-flight request safeguards are unchanged. Failed compaction does not
advance the context cycle; context clearing is separate and does not request
recovery. Lower token readings do not invent a successful compaction.

Compactions that occur while the extension is unloaded or disconnected cannot
be observed or reconstructed. Saved pending recovery survives reload. The
legacy historical-count field is retained for compatibility but is not queried
or used for decisions.

This stabilization release does **not** include the separate idle-integration
feature or the superseded every-fifth-checkpoint integration policy.
Installation updates shared files; already-open sessions need their own normal
extension reload to activate them.

### Validation

All **239 regression tests passed**. Coverage includes startup without any
attribution request, client-name independence, successful/failed/duplicate
compaction events, context clearing, reload persistence, capture gating and
bounded logging after successful persistence.

Live verification confirmed successful events-only attachment, a fresh renewed
status contribution and restored last/next checkpoint rendering. This is not a
claim that a natural post-install compaction/recovery has been verified end to end.

### Install

```powershell
npx --yes "github:joniba/basic-memory-copilot-bridge#fix/event-only-compaction" --update
```
