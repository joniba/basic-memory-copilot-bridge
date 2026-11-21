# Implementation plan

Status: independent design review passed. The first implementation review found
lifecycle blockers; focused corrections are implemented and all 285 regression
tests pass. Repeated isolated native acceptance also passes. Obtain renewed
implementation and exact-object privacy reviews before publication.

## 1. Review the policy and boundary

- Confirm the 65% normal-turn criterion, 70% delivery criterion, 75% decisions
  and the narrow bridge scope.
- Review `design.md` with the independent design reviewer before implementation.
- Preserve the main stabilization fixes and all unrelated worktrees.
- No new API beyond the specifically approved 75% `session.abort()` call.

## 2. Implement prompts and mechanical stage handling

- Add the bracketed standard-interval, pressure and emergency prompt headers.
- Replace the final finish instruction with agent-owned continuation wording.
- Add bounded per-cycle request-delivery/attempt bookkeeping and compatible
  state migration; do not infer history.
- Reuse existing native usage, receipt and serialized handling.
- Keep normal capture timing; add idle-only 75% after a normally finished
  65% checkpoint, even if saving was skipped.
- Add one immediate 70% poke and one 75% emergency only when delivery is missing.
- Keep existing guards and manage only owned pending checkpoint requests.
- Use the approved single queue snapshot before aggressive cancellation;
  skip/log when unrelated pending work exists, with no restore controller.
- Add bounded, sanitized delivery/interruption logs, not quality/task analysis.

## 3. Verify behavior

- Run focused regressions for thresholds, delivery, duplicates, pending
  messages, compaction/clear/reload, cancellation, headers and continuation.
- Prove no extra polling, history scans, save verification or task controller.
- Run the existing full regression suite.
- Where needed, use bounded isolated native fixtures, not forced events in
  working sessions or production corpus writes.
- Obtain independent implementation review; resolve concrete findings without
  expanding the scope.
- Cover interruption during held startup, automatic input after cancellation,
  uncertain receipts across reload and context reset, an unsent steering
  reservation racing normal checkpoint delivery, and cross-cycle records through
  the actual capped logger.
- Cover interrupted recovery while processing/admission reads are held and
  after reservation, so a queued cancellation handler cannot be overtaken by
  another automated turn.

## 4. Publish for review

- Commit with public-safe metadata and required trailers.
- Obtain independent privacy approval for the exact outgoing objects.
- Publish `feature/pressure-escalation` and give the branch-based npx command.
- Keep main merge and installation/reload as separate requested actions.

## Decisions to raise only if implementation exposes them

Native delivery and cancellation ordering, interrupted-request lifecycle and
pending-message replacement need concrete tests. Do not turn those tests into
reasoning about capture quality, the user's task, or safe task resumption.
If the approved APIs cannot realize the policy, report that directly instead of
adding another API, workaround, timeout controller or broader automation.
