import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  applyUsage, bridgeDiagnostic, CaptureBridge, checkpointPrompt, defaults,
  eligibility, FileStateStore, freshState, validateConfig,
  statusContribution,
  recoveryPrompt,
  pressureEscalation,
} from '../extension/bridge.mjs';
import { createLogger, settleLogger } from './helpers/diagnostics.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifacts = join(root, '.test-artifacts');
await mkdir(artifacts, { recursive: true });
const run = await mkdtemp(join(artifacts, 'extension-unit-'));
const start = Date.parse('2026-10-08T10:00:00Z');

async function fixture(overrides = {}, id = 'test-session', beforeStart = async () => {}) {
  const directory = await mkdtemp(join(run, 'case-'));
  const store = new FileStateStore(join(directory, 'sessions'), id);
  const sent = [];
  const logs = [];
  const warnings = [];
  const removed = [];
  const statuses = [];
  const aborts = [];
  let config = validateConfig(overrides);
  let now = start;
  let info = { totalTokens: 1000, limit: 200000 };
  let active = false;
  let processing = true;
  let pending = [];
  const session = {
    sessionId: id,
    log: async (message, options) => warnings.push({ message, options }),
    send: async message => { sent.push(message); return `message-${sent.length}`; },
    abort: async () => { aborts.push(now); },
    rpc: {
      metadata: {
        snapshot: async () => ({ workingDirectory: directory, isRemote: false, clientName: 'copilot-cli' }),
        contextInfo: async () => ({ contextInfo: info }),
        getContextAttribution: async () => { assert.fail('Attribution must never be requested.'); },
        activity: async () => ({ hasActiveWork: active }),
        isProcessing: async () => ({ processing }),
      },
      queue: {
        pendingItems: async () => ({ items: pending, steeringMessages: [] }),
        removeAt: async ({ id }) => { removed.push(id); pending = pending.filter(item => item.id !== id); return { removed: true }; },
      },
    },
  };
  const create = () => new CaptureBridge({
    session, store, config: async () => config, log: async row => logs.push(row),
    status: async value => statuses.push(value), clock: () => now,
  });
  let bridge = create();
  await beforeStart({ session, store });
  await bridge.start();
  const f = {
    directory, store, session, sent, logs, warnings, removed, statuses, aborts,
    state: async () => JSON.parse(await readFile(store.path, 'utf8')),
    info: value => { info = value; },
    usage: async (tokens, limit = 100000) => {
      info = { totalTokens: tokens, limit };
      return bridge.on({ type: 'session.usage_info', data: { currentTokens: tokens, tokenLimit: limit } });
    },
    time: value => { now = value; },
    config: value => { config = validateConfig(value); },
    active: value => { active = value; },
    processing: value => { processing = value; },
    pending: value => { pending = value; },
    event: async (type, data = {}, extra = {}) => bridge.on({ type, data, id: `${type}-${now}`, ...extra }),
    idle: async (aborted = false) => bridge.on({ type: 'session.idle', data: { aborted } }),
    reload: async () => { bridge = create(); await bridge.start(); },
  };
  return f;
}

test('local sessions attach regardless of telemetry client name without requesting attribution', async t => {
  for (const clientName of ['github/cli', 'copilot-cli', 'synthetic-other-client', undefined]) {
    await t.test(String(clientName), async () => {
      let attributionCalls = 0;
      const f = await fixture({}, 'test-session', async ({ session }) => {
        session.rpc.metadata.snapshot = async () => ({
          workingDirectory: run, isRemote: false, clientName,
        });
        session.rpc.metadata.getContextAttribution = async () => {
          attributionCalls += 1;
          throw new Error('unknown variant memory');
        };
      });
      assert.equal(attributionCalls, 0);
      assert.ok(f.logs.some(row => row.gateDecision === 'attached' && row.trackingMode === 'events-only'));
      assert.equal(f.statuses.at(-1).kind, 'hint');
      f.info({ totalTokens: 51000, limit: 200000 });
      await f.idle();
      assert.equal(f.sent.length, 1);
      assert.equal(attributionCalls, 0);
    });
  }
});

test('event-only tracking preserves existing state on reload and separates successful compaction from clear and failure', async () => {
  const f = await fixture();
  await f.store.transaction(state => Object.assign(state, {
    nativeCompactionCount: 7, compactionEpoch: 9, lastCompactionEventId: 'earlier',
    lastOpportunityAt: start - 1000, lastCheckpointAt: start - 500,
    lastCheckpointTokens: 90000, pressureOpportunityEpoch: 9,
  }));
  await f.reload();
  assert.equal((await f.state()).compactionEpoch, 9);
  assert.equal((await f.state()).nativeCompactionCount, 7);
  await f.event('session.compaction_complete', { success: false }, { id: 'failed' });
  assert.equal((await f.state()).compactionEpoch, 9);
  assert.equal((await f.state()).lastCompactionEventId, 'earlier');
  await f.event('session.compaction_complete', { success: true }, { id: 'success' });
  const compacted = await f.state();
  assert.equal(compacted.compactionEpoch, 10);
  assert.equal(compacted.pendingRecoveryEpoch, 10);
  assert.equal(compacted.nativeCompactionCount, 7, 'Unused historical field remains untouched.');
  assert.equal(compacted.lastOpportunityAt, start - 1000);
  assert.equal(compacted.lastCheckpointAt, start - 500);
  assert.equal(compacted.lastCheckpointTokens, 90000);
  assert.equal(compacted.pressureOpportunityEpoch, 9);
  await f.reload();
  await f.event('session.compaction_complete', { success: true }, { id: 'success' });
  assert.equal((await f.state()).compactionEpoch, 10);
  assert.equal((await f.state()).pendingRecoveryEpoch, 10);
  await f.event('session.context_cleared', {}, { id: 'clear' });
  assert.equal((await f.state()).compactionEpoch, 11);
  assert.equal((await f.state()).pendingRecoveryEpoch, null);
  assert.equal((await f.state()).nativeCompactionCount, 7);
  assert.ok(f.logs.some(row => row.gateDecision === 'compaction-error' && row.compactionEpoch === 9));
  assert.ok(f.logs.some(row => row.gateDecision === 'epoch-reset' && row.compactionEpoch === 10 && row.recoveryPending));
  assert.ok(f.logs.some(row => row.gateDecision === 'duplicate-compaction-ignored' && row.compactionEpoch === 10));
  assert.ok(f.logs.some(row => row.gateDecision === 'context-cleared' && row.compactionEpoch === 11 && !row.recoveryPending));
});

test('compaction queued during startup is handled once after initialization finishes', async () => {
  const f = await fixture();
  let release;
  f.session.rpc.metadata.snapshot = () => new Promise(resolve => { release = resolve; });
  const bridge = new CaptureBridge({
    session: f.session, store: f.store, config: async () => defaults,
    log: async row => f.logs.push(row), clock: () => start,
  });
  const starting = bridge.start();
  const event = { type: 'session.compaction_complete', id: 'during-startup', data: { success: true } };
  const completing = bridge.on(event);
  await new Promise(resolve => setImmediate(resolve));
  release({ workingDirectory: run, isRemote: false, clientName: 'github/cli' });
  await Promise.all([starting, completing]);
  await bridge.on(event);
  assert.equal((await f.state()).compactionEpoch, 1);
  assert.equal((await f.state()).pendingRecoveryEpoch, 1);
  assert.equal(f.sent.length, 0);
});

test('compaction transition is logged only after its state has been persisted', async () => {
  const f = await fixture();
  const transaction = f.store.transaction.bind(f.store);
  f.store.transaction = async () => { throw Object.assign(new Error('synthetic state failure'), { code: 'EIO' }); };
  f.logs.length = 0;
  await f.event('session.compaction_complete', { success: true }, { id: 'not-persisted' });
  assert.ok(!f.logs.some(row => row.gateDecision === 'epoch-reset'));
  f.store.transaction = transaction;
  assert.equal((await f.state()).compactionEpoch, 0);
  await f.event('session.compaction_complete', { success: true }, { id: 'not-persisted' });
  assert.equal((await f.state()).compactionEpoch, 1);
  assert.ok(f.logs.some(row => row.gateDecision === 'epoch-reset'));
});

test('persisted transition logs whitelist state fields and preserve distinct compactions within a minute', async () => {
  const directory = await mkdtemp(join(run, 'transition-logs-'));
  const logger = createLogger(directory, 'test-session', () => start);
  await logger.ready;
  const record = {
    event: 'session.compaction_complete', gateDecision: 'epoch-reset', compactionEpoch: 1,
    recoveryPending: true, trackingMode: 'events-only', prompt: 'private-synthetic-prompt',
  };
  await logger(record);
  await logger(record);
  await logger({ ...record, compactionEpoch: 2 });
  await logger({ event: 'startup', gateDecision: 'attached', trackingMode: 'private-mode',
    compactionEpoch: 'private-epoch', recoveryPending: 'private-flag' });
  await settleLogger(logger);
  const text = await readFile(join(directory, 'test-session.jsonl'), 'utf8');
  const rows = text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].compactionEpoch, 1);
  assert.equal(rows[1].compactionEpoch, 2);
  assert.equal(rows[0].recoveryPending, true);
  assert.equal(rows[0].trackingMode, 'events-only');
  assert.ok(!text.includes('private'));
});

test('one attributed queued notice accompanies activity transitions without routine lifecycle chatter', async () => {
  const f = await fixture();
  f.info({ totalTokens: 51000, limit: 200000 });
  await f.idle();
  assert.ok(f.sent[0].prompt.startsWith('[basic-memory-bridge: standard-interval-checkpoint]\n'));
  assert.equal(f.statuses.at(-1).label, 'queued');
  assert.equal(f.statuses.at(-1).prefix, 'last checkpoint: none, next checkpoint: ');
  assert.deepEqual(f.warnings.map(value => value.message), [
    '[basic-memory-bridge] Memory checkpoint queued',
  ]);
  await f.event('user.message', { messageId: 'message-1' });
  assert.equal(f.statuses.at(-1).label, 'in progress');
  assert.equal(f.statuses.at(-1).prefix, 'last checkpoint: none, next checkpoint: ');
  await f.event('user.message', { messageId: 'message-1' });
  f.info({ totalTokens: 53000, limit: 200000 });
  await f.idle();
  assert.equal(f.statuses.at(-1).kind, 'hint');
  assert.deepEqual(f.warnings.map(value => value.message), ['[basic-memory-bridge] Memory checkpoint queued']);
  assert.equal((await f.state()).lastCheckpointTokens, 53000);
  assert.equal(f.sent.length, 1);
  assert.ok(!f.warnings.some(value => /saved/i.test(value.message)));
});

test('accepted pressure opportunity resets periodic hint time and post-checkpoint token watermark', async () => {
  const f = await fixture();
  f.info({ totalTokens: 130000, limit: 200000 });
  await f.idle();
  assert.ok(f.sent[0].prompt.startsWith('[basic-memory-bridge: pressure-checkpoint]\n'));
  assert.equal((await f.state()).pressureOpportunityEpoch, 0);
  await f.event('user.message', { messageId: 'message-1' });
  f.info({ totalTokens: 132000, limit: 200000 });
  await f.idle();
  const hint = f.statuses.at(-1);
  assert.equal(hint.targets.length, 2);
  assert.equal(hint.targets[0].tokens, 182000);
  assert.equal(hint.targets[0].notBefore, start + 3600000);
  assert.equal(hint.targets[1].tokens, 150000);
  assert.equal(hint.targets[1].notBefore, start + 300000);
  assert.equal((await f.state()).lastOpportunityTokens, 132000);
});

test('checkpoint prompts identify automation and return continuation responsibility to the agent', () => {
  for (const type of ['standard-interval-checkpoint', 'pressure-checkpoint', 'emergency-checkpoint']) {
    const prompt = checkpointPrompt('prompt-test', { cwd: 'C:\\synthetic', branch: 'synthetic' }, type);
    assert.ok(prompt.startsWith(`[basic-memory-bridge: ${type}]\n`));
    assert.match(prompt, /"thread_id":"copilot:prompt-test"/);
    assert.ok(prompt.endsWith('After capturing memory or deciding not to, resume your previous unfinished task, respecting newer instructions and explicit stop/cancel requests.'));
    assert.ok(!prompt.includes('Finish normally.'));
  }
  assert.throws(() => checkpointPrompt('prompt-test', {}, 'unknown'), /checkpoint-type-invalid/);
});

test('a normally finished 65% checkpoint permits an extra idle-only 75% checkpoint after the existing gap', async () => {
  const f = await fixture({ recoverAfterCompaction: false });
  await f.usage(65000);
  await f.idle();
  assert.equal((await f.state()).captureInFlight.kind, 'pressure');
  await f.event('user.message', { messageId: 'message-1' });
  await f.usage(74000);
  await f.idle();
  assert.equal((await f.state()).pressureCompletedEpoch, 0);
  await f.usage(75000);
  assert.equal(f.sent.length, 1);
  f.time(start + 299999);
  await f.idle();
  assert.equal(f.sent.length, 1);
  f.time(start + 300000);
  await f.idle();
  assert.equal(f.sent.length, 2);
  assert.equal((await f.state()).captureInFlight.kind, 'pressure-extra');
  assert.equal((await f.state()).pressureExtraOpportunityEpoch, 0);
  assert.equal(f.sent[1].mode, 'enqueue');
  assert.ok(f.sent[1].prompt.startsWith('[basic-memory-bridge: pressure-checkpoint]'));
  assert.equal(f.aborts.length, 0);
  await f.event('user.message', { messageId: 'message-2' });
  await f.idle();
  f.time(start + 600000);
  await f.usage(85000);
  await f.idle();
  assert.equal(f.sent.length, 2);
  assert.equal(f.aborts.length, 0);
});

test('the 70% step steers without idle and its actual delivery suppresses aggressive and extra 75% requests', async () => {
  const f = await fixture();
  f.active(true);
  await f.usage(69999);
  assert.equal(f.sent.length, 0);
  await f.usage(70000);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].mode, 'immediate');
  assert.equal((await f.state()).captureInFlight.kind, 'pressure-steering');
  assert.equal((await f.state()).pressureSteeringDeliveredEpoch, null);
  await f.event('user.message', { messageId: 'message-1' });
  assert.equal((await f.state()).pressureSteeringDeliveredEpoch, 0);
  assert.equal(f.statuses.at(-1).label, 'delivered');
  await f.event('assistant.turn_end');
  await f.usage(75000);
  assert.equal(f.sent.length, 1);
  assert.equal(f.aborts.length, 0);
  f.active(false);
  await f.idle();
  await f.idle();
  assert.equal(f.sent.length, 1);
  assert.equal((await f.state()).pressureCompletedEpoch, null);
  assert.ok(f.logs.some(row => row.gateDecision === 'pressure-steering-delivered'));
});

test('undelivered 70% steering escalates once at 75% with the approved abort and an emergency prompt', async () => {
  const f = await fixture();
  f.active(true);
  await f.usage(70000);
  await f.usage(74999);
  assert.equal(f.aborts.length, 0);
  await f.usage(75000);
  assert.equal(f.sent.length, 2);
  assert.equal(f.aborts.length, 1);
  assert.equal((await f.state()).captureInFlight.kind, 'emergency');
  assert.ok(f.sent[1].prompt.startsWith('[basic-memory-bridge: emergency-checkpoint]'));
  assert.equal(f.sent[1].mode, 'enqueue');
  await f.event('user.message', { messageId: 'message-2' });
  await f.usage(80000);
  f.active(false);
  await f.idle();
  await f.idle();
  assert.equal(f.sent.length, 2);
  assert.equal(f.aborts.length, 1);
  assert.ok(f.logs.some(row => row.gateDecision === 'emergency-abort-requested'));
  assert.ok(f.logs.some(row => row.gateDecision === 'emergency-abort-returned'));
});

test('an initial jump to 75% starts only the emergency step and missing legacy fields migrate prospectively', async () => {
  const f = await fixture();
  await f.usage(75000);
  assert.equal(f.sent.length, 1);
  assert.equal(f.aborts.length, 1);
  assert.equal((await f.state()).pressureSteeringAttemptEpoch, null);
  assert.equal((await f.state()).pressureEmergencyAttemptEpoch, 0);
  const legacy = await fixture();
  const state = await legacy.state();
  for (const key of ['pressureCompletedEpoch', 'pressureExtraOpportunityEpoch', 'pressureSteeringAttemptEpoch',
    'pressureSteeringDeliveredEpoch', 'pressureEmergencyAttemptEpoch']) delete state[key];
  state.lastCheckpointTokens = 198000;
  state.lastCheckpointAt = start - 1000;
  await writeFile(legacy.store.path, JSON.stringify(state));
  await legacy.reload();
  assert.equal((await legacy.state()).pressureCompletedEpoch, null);
  assert.equal((await legacy.state()).lastCheckpointTokens, 198000);
});

test('capture-then-continue stays protected until native finish, even when ongoing work crosses 70% and 75%', async () => {
  const f = await fixture();
  await f.usage(65000);
  await f.idle();
  await f.event('user.message', { messageId: 'message-1' });
  await f.event('assistant.turn_end');
  await f.usage(70000);
  await f.usage(75000);
  assert.equal((await f.state()).pressureCompletedEpoch, null);
  assert.equal(f.sent.length, 1);
  assert.equal(f.aborts.length, 0);
  f.time(start + 300000);
  await f.idle();
  assert.equal((await f.state()).pressureCompletedEpoch, 0);
  assert.equal(f.sent.length, 2);
  assert.equal((await f.state()).captureInFlight.kind, 'pressure-extra');
  assert.equal(f.aborts.length, 0);
});

test('aborted, errored and unconfirmed pressure requests cannot select the successful 65% branch', async () => {
  for (const outcome of ['aborted', 'errored', 'unconfirmed']) {
    const f = await fixture();
    await f.usage(65000);
    await f.idle();
    if (outcome !== 'unconfirmed') await f.event('user.message', { messageId: 'message-1' });
    if (outcome === 'errored') {
      await f.event('session.error');
      await f.reload();
    }
    await f.idle(outcome === 'aborted');
    assert.equal((await f.state()).pressureCompletedEpoch, null, outcome);
  }
});

test('compaction and clearing reset escalation stages, but a token decrease does not', async () => {
  const f = await fixture({ recoverAfterCompaction: false });
  await f.usage(70000);
  await f.event('user.message', { messageId: 'message-1' });
  await f.idle();
  await f.usage(1000);
  await f.usage(75000);
  assert.equal(f.sent.length, 1);
  await f.event('session.compaction_complete', { success: true });
  await f.usage(70000);
  assert.equal(f.sent.length, 2);
  await f.event('user.message', { messageId: 'message-2' });
  await f.idle();
  await f.event('session.context_cleared');
  await f.usage(75000);
  assert.equal(f.sent.length, 3);
  assert.equal(f.aborts.length, 1);
});

test('failed escalation attempts do not loop and disabling or user cancellation suppresses new interventions', async () => {
  const f = await fixture();
  f.session.send = async () => { throw new Error('synthetic send failure'); };
  await f.usage(70000);
  await f.usage(71000);
  assert.equal((await f.state()).pressureSteeringAttemptEpoch, 0);
  assert.equal(f.aborts.length, 0);
  f.session.abort = async () => { throw Object.assign(new Error('synthetic abort failure'), { code: 'EIO' }); };
  await f.usage(75000);
  await f.usage(80000);
  assert.equal((await f.state()).pressureEmergencyAttemptEpoch, 0);
  assert.equal(f.aborts.length, 0);
  assert.ok(f.logs.some(row => row.operation === 'session.abort' && row.code === 'EIO'));
  const disabled = await fixture({ enabled: false });
  await disabled.usage(80000);
  assert.equal(disabled.sent.length, 0);
  assert.equal(disabled.aborts.length, 0);
  const cancelled = await fixture();
  await cancelled.idle(true);
  await cancelled.usage(80000);
  assert.equal(cancelled.sent.length, 0);
  assert.equal(cancelled.aborts.length, 0);
});

test('a native delivery received during an earlier await suppresses cancellation before its queued handler runs', async () => {
  const f = await fixture();
  await f.usage(70000);
  const first = f.sent[0];
  const pending = f.session.rpc.queue.pendingItems;
  let receipt;
  f.session.rpc.queue.pendingItems = async () => {
    f.session.rpc.queue.pendingItems = pending;
    receipt = f.event('user.message', { source: 'system', content: first.displayPrompt, messageId: 'message-1' });
    return { items: [], steeringMessages: [] };
  };
  await f.usage(75000);
  await receipt;
  assert.equal(f.aborts.length, 0);
  assert.equal(f.sent.length, 1);
  assert.equal((await f.state()).pressureSteeringDeliveredEpoch, 0);
});

test('delivery before the send response supplies a message ID retains the owned steering correlation', async () => {
  const f = await fixture();
  let delivered;
  f.session.send = async message => {
    f.sent.push(message);
    delivered = f.event('user.message', { source: 'system', content: message.displayPrompt, messageId: 'early-id' });
    return 'early-id';
  };
  await f.usage(70000);
  await delivered;
  await f.usage(75000);
  assert.equal(f.sent.length, 1);
  assert.equal(f.aborts.length, 0);
  assert.equal((await f.state()).pressureSteeringDeliveredEpoch, 0);
});

test('escalation uses raw exact boundaries and is independent of capture cooldown and token growth', () => {
  const state = Object.assign(freshState('boundaries'), {
    baselineTokens: 74999, lastContextTokens: 69999, tokenLimit: 100000,
    lastOpportunityAt: start, pressurePending: false,
  });
  assert.equal(pressureEscalation(state, defaults), null);
  state.lastContextTokens = 70000;
  assert.equal(pressureEscalation(state, defaults), 'pressure-steering');
  state.pressureSteeringAttemptEpoch = 0;
  state.lastContextTokens = 74999;
  assert.equal(pressureEscalation(state, defaults), null);
  state.lastContextTokens = 75000;
  assert.equal(pressureEscalation(state, defaults), 'emergency');
});

test('an emergency uses one queue snapshot and leaves unrelated pending work and the earlier steering request untouched', async () => {
  for (const queued of ['user-item', 'user-steering']) {
    const f = await fixture();
    await f.usage(70000);
    const steering = f.sent[0];
    let snapshots = 0;
    f.session.rpc.queue.pendingItems = async () => {
      snapshots += 1;
      return {
        items: queued === 'user-item' ? [{ id: 'unrelated', messageId: 'human-message', source: 'user' }] : [],
        steeringMessages: queued === 'user-steering' ? [steering.displayPrompt, 'user instruction'] : [steering.displayPrompt],
      };
    };
    await f.usage(75000);
    assert.equal(snapshots, 1);
    assert.equal(f.aborts.length, 0);
    assert.equal(f.sent.length, 1);
    assert.equal(f.removed.length, 0);
    assert.equal((await f.state()).captureInFlight.kind, 'pressure-steering');
    assert.equal((await f.state()).pressureEmergencyAttemptEpoch, 0);
    assert.ok(f.logs.some(row => row.gateDecision === 'emergency-skipped-queued-work'));
    const warning = f.warnings.find(row => row.options.level === 'warning');
    assert.match(warning.message, /Emergency checkpoint skipped.*Pause pending work.*memory-capture/);
    await f.usage(80000);
    assert.equal(snapshots, 1, 'No queue watcher or repeated emergency check.');
    assert.equal(f.warnings.filter(row => row.options.level === 'warning').length, 1);
  }
});

test('a pending owned checkpoint can be replaced without touching unrelated queue items at the steering stage', async () => {
  const f = await fixture();
  await f.usage(65000);
  await f.idle();
  f.pending([
    { id: 'own-pending', messageId: 'message-1', source: 'system' },
    { id: 'user-pending', messageId: 'human-message', source: 'user' },
  ]);
  await f.usage(70000);
  assert.deepEqual(f.removed, ['own-pending']);
  const pending = await f.session.rpc.queue.pendingItems();
  assert.deepEqual(pending.items.map(item => item.id), ['user-pending']);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].mode, 'immediate');
});

test('native interrupted idle is honored without guessing its source, and shutdown suppresses sending', async () => {
  const f = await fixture();
  let aborted;
  f.session.abort = async () => { f.aborts.push(start); aborted = f.idle(true); };
  await f.usage(75000);
  await aborted;
  assert.equal(f.sent.length, 0);
  assert.equal((await f.state()).pressureEscalationPaused, true);
  await f.reload();
  await f.usage(80000);
  assert.equal(f.sent.length, 0, 'Reload must not undo a cancellation.');
  assert.ok(f.logs.some(row => row.gateDecision === 'pressure-stopped'));
  const shutdown = await fixture();
  let stopped;
  shutdown.session.abort = async () => { stopped = shutdown.event('session.shutdown'); };
  await shutdown.usage(75000);
  await stopped;
  assert.equal(shutdown.sent.length, 0);
  assert.equal((await shutdown.state()).captureInFlight, null);
});

test('a failed emergency queue read restores the existing request instead of leaving an unsent reservation', async () => {
  const f = await fixture();
  await f.usage(70000);
  f.session.rpc.queue.pendingItems = async () => { throw Object.assign(new Error('synthetic queue failure'), { code: 'EACCES' }); };
  await f.usage(75000);
  assert.equal((await f.state()).captureInFlight.kind, 'pressure-steering');
  assert.equal((await f.state()).captureInFlight.messageId, 'message-1');
  assert.equal(f.aborts.length, 0);
  assert.equal(f.sent.length, 1);
  assert.ok(f.logs.some(row => row.operation === 'queue.pending-items' && row.code === 'EACCES'));
  await f.event('user.message', { messageId: 'message-1' });
  assert.equal((await f.state()).pressureSteeringDeliveredEpoch, 0);
});

test('a receipt reconciles a replacement steering send whose response failed without resurrecting the old request', async () => {
  const f = await fixture();
  await f.usage(65000);
  await f.idle();
  f.pending([{ id: 'old-pending', messageId: 'message-1', source: 'system' }]);
  let delivered;
  f.session.send = async message => {
    f.sent.push(message);
    delivered = f.event('user.message', {
      source: 'system', content: message.displayPrompt, messageId: 'received-replacement',
    });
    throw Object.assign(new Error('synthetic missing acknowledgement'), { code: -32603 });
  };
  await f.usage(70000);
  await delivered;
  await f.usage(75000);
  assert.equal((await f.state()).captureInFlight.kind, 'pressure-steering');
  assert.equal((await f.state()).captureInFlight.messageId, 'received-replacement');
  assert.equal((await f.state()).pressureSteeringDeliveredEpoch, 0);
  assert.equal(f.aborts.length, 0);
  assert.equal(f.sent.length, 2);
});

test('review regression: interruption observed during startup prevents escalation before fresh user input', async t => {
  for (const recoveryPending of [false, true]) {
    await t.test(recoveryPending ? 'pending recovery' : 'pressure only', async () => {
      const f = await fixture();
      if (recoveryPending) await f.store.transaction(state => {
        state.compactionEpoch = 1;
        state.pendingRecoveryEpoch = 1;
      });
      f.processing(false);
      let release;
      f.session.rpc.metadata.snapshot = () => new Promise(resolve => { release = resolve; });
      f.session.rpc.metadata.contextInfo = async () => ({ contextInfo: { totalTokens: 75000, limit: 100000 } });
      const bridge = new CaptureBridge({
        session: f.session, store: f.store, config: async () => defaults,
        log: async row => f.logs.push(row), clock: () => start,
      });
      const starting = bridge.start();
      const interrupted = bridge.on({ type: 'session.idle', data: { aborted: true } });
      await new Promise(resolve => setImmediate(resolve));
      release({ workingDirectory: run, isRemote: false, clientName: 'github/cli' });
      await Promise.all([starting, interrupted]);
      assert.equal(f.sent.length, 0);
      assert.equal(f.aborts.length, 0);
      assert.equal((await f.state()).pressureEscalationPaused, true);
      await bridge.on({ type: 'user.message', data: { source: 'user', content: 'Continue the task.', messageId: 'human' } });
      await bridge.on({ type: 'session.usage_info', data: { currentTokens: 75000, tokenLimit: 100000 } });
      assert.equal(f.sent.length, 1);
      assert.equal(f.aborts.length, 1);
    });
  }
});

test('review regression: automated origins cannot clear an interruption pause', async t => {
  const origins = ['memory', 'skill', 'inter-agent', 'agent-reviewer', 'automation-schedule', 'system', 'autopilot'];
  for (const source of origins) {
    await t.test(source, async () => {
      const f = await fixture();
      await f.idle(true);
      await f.event('user.message', { source, content: 'Automatic input.', messageId: source });
      await f.usage(75000);
      assert.equal((await f.state()).pressureEscalationPaused, true);
      assert.equal(f.sent.length, 0);
      assert.equal(f.aborts.length, 0);
      await f.event('user.message', { source: 'user', content: 'Continue.', messageId: 'human' });
      await f.usage(75000);
      assert.equal(f.sent.length, 1);
    });
  }
  for (const source of [undefined, 'user']) {
    await t.test(`autopilot continuation with ${source ?? 'default'} source`, async () => {
      const f = await fixture();
      await f.idle(true);
      await f.event('user.message', { source, isAutopilotContinuation: true, content: 'Continue.', messageId: 'autopilot' });
      await f.usage(75000);
      assert.equal((await f.state()).pressureEscalationPaused, true);
      assert.equal(f.sent.length, 0);
      assert.equal(f.aborts.length, 0);
    });
  }
  await t.test('default-source relay wrapper', async () => {
    const f = await fixture();
    await f.idle(true);
    await f.event('user.message', { content: '[agent-relay] Message from: reviewer\nReview results.', messageId: 'relay' });
    await f.usage(75000);
    assert.equal((await f.state()).pressureEscalationPaused, true);
    assert.equal(f.sent.length, 0);
    await f.event('user.message', { content: 'Continue.', messageId: 'human-default-source' });
    await f.usage(75000);
    assert.equal(f.sent.length, 1);
  });
});

test('review regression: uncertain steering receipt remains correlated after reload', async () => {
  const f = await fixture();
  f.session.send = async message => {
    f.sent.push(message);
    throw Object.assign(new Error('Synthetic missing response.'), { code: -32603 });
  };
  await f.usage(70000);
  const label = f.sent[0].displayPrompt;
  await f.reload();
  await f.event('user.message', { source: 'system', content: label, messageId: 'late-receipt' });
  await f.usage(75000);
  assert.equal(f.aborts.length, 0);
  assert.equal(f.sent.length, 1);
  assert.equal((await f.state()).pressureSteeringDeliveredEpoch, 0);
});

test('review regression: uncertain receipt during reload suppresses startup emergency before its queued handler', async () => {
  const f = await fixture();
  f.session.send = async message => {
    f.sent.push(message);
    throw new Error('Synthetic response unavailable.');
  };
  await f.usage(70000);
  const label = f.sent[0].displayPrompt;
  f.info({ totalTokens: 75000, limit: 100000 });
  const reloading = f.reload();
  const receipt = f.event('user.message', { source: 'system', content: label, messageId: 'during-reload' });
  await Promise.all([reloading, receipt]);
  assert.equal(f.aborts.length, 0);
  assert.equal(f.sent.length, 1);
  assert.equal((await f.state()).pressureSteeringDeliveredEpoch, 0);
});

test('review regression: a late uncertain receipt from before compaction or clear cannot select the new cycle', async t => {
  for (const type of ['session.compaction_complete', 'session.context_cleared']) {
    await t.test(type, async () => {
      const f = await fixture({ recoverAfterCompaction: false });
      f.session.send = async message => {
        f.sent.push(message);
        throw new Error('Synthetic response unavailable.');
      };
      await f.usage(70000);
      const label = f.sent[0].displayPrompt;
      await f.event(type, { success: true }, { id: 'new-cycle' });
      await f.event('user.message', { source: 'system', content: label, messageId: 'late-old-receipt' });
      await f.usage(75000);
      assert.equal(f.aborts.length, 1);
      assert.equal(f.sent.length, 2);
      assert.equal((await f.state()).pressureSteeringDeliveredEpoch, null);
      assert.equal((await f.state()).uncertainRequest.kind, 'emergency');
    });
  }
});

test('review regression: 65% delivery during unsent 70% preparation preserves the extra idle 75% branch', async () => {
  const f = await fixture();
  await f.usage(65000);
  await f.idle();
  const label = f.sent[0].displayPrompt;
  const pending = f.session.rpc.queue.pendingItems;
  let receipt;
  f.session.rpc.queue.pendingItems = async () => {
    f.session.rpc.queue.pendingItems = pending;
    receipt = f.event('user.message', { source: 'system', content: label, messageId: 'message-1' });
    return { items: [], steeringMessages: [] };
  };
  await f.usage(70000);
  await receipt;
  assert.equal(f.sent.length, 1, 'No 70% steering was actually sent.');
  await f.usage(75000);
  f.time(start + 300000);
  await f.idle();
  assert.equal(f.sent.length, 2);
  assert.equal((await f.state()).captureInFlight.kind, 'pressure-extra');
  assert.equal(f.aborts.length, 0);
});

test('review regression: actual capped logger retains critical pressure records from separate cycles', async () => {
  const f = await fixture({ recoverAfterCompaction: false });
  const directory = await mkdtemp(join(run, 'pressure-cycle-logs-'));
  const logger = createLogger(directory, f.session.sessionId, () => start);
  await logger.ready;
  const bridge = new CaptureBridge({
    session: f.session, store: f.store, config: async () => validateConfig({ recoverAfterCompaction: false }),
    log: logger, clock: () => start,
  });
  await bridge.start();
  for (let cycle = 0; cycle < 4; cycle += 1) {
    if (cycle) await bridge.on({ type: 'session.context_cleared', id: `clear-${cycle}`, data: {} });
    await bridge.on({ type: 'session.usage_info', data: { currentTokens: cycle < 2 ? 70000 : 75000, tokenLimit: 100000 } });
    await bridge.on({ type: 'user.message', data: { source: 'system', content: f.sent.at(-1).displayPrompt,
      messageId: `message-${f.sent.length}` } });
    await bridge.on({ type: 'session.idle', data: {} });
  }
  await settleLogger(logger);
  assert.equal(logger.getHealth().delivery.destinations[0].overflow, 0);
  const rows = (await readFile(join(directory, `${f.session.sessionId}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.filter(row => row.gateDecision === 'pressure-steering-delivered').map(row => row.compactionEpoch), [0, 1]);
  assert.deepEqual(rows.filter(row => row.gateDecision === 'emergency-abort-requested').map(row => row.compactionEpoch), [2, 3]);
  assert.deepEqual(rows.filter(row => row.gateDecision === 'emergency-abort-returned').map(row => row.compactionEpoch), [2, 3]);
});

test('aborted checkpoint clears the active label and shows no recursion or success claim', async () => {
  const f = await fixture();
  f.info({ totalTokens: 51000, limit: 200000 });
  await f.idle();
  await f.event('user.message', { messageId: 'message-1' });
  await f.idle(true);
  assert.equal((await f.state()).captureInFlight, null);
  assert.equal(f.statuses.at(-1).kind, 'hint');
  assert.deepEqual(f.warnings.map(value => value.message), ['[basic-memory-bridge] Memory checkpoint queued']);
  assert.equal(f.sent.length, 1);
});

test('aborted unstarted request clears when no longer queued but preserves a still-pending request', async () => {
  const f = await fixture();
  f.info({ totalTokens: 51000, limit: 200000 });
  await f.idle();
  f.pending([{ id: 'queued', messageId: 'message-1' }]);
  await f.idle(true);
  assert.notEqual((await f.state()).captureInFlight, null);
  assert.equal(f.statuses.at(-1).label, 'queued');
  f.pending([]);
  await f.idle(true);
  assert.equal((await f.state()).captureInFlight, null);
  assert.equal(f.statuses.at(-1).kind, 'hint');
});

test('send failure clears activity and publishes an idle retry hint with attributed error', async () => {
  const f = await fixture();
  f.info({ totalTokens: 51000, limit: 200000 });
  f.session.send = async () => { throw new Error('private send failure'); };
  await f.idle();
  assert.equal(f.statuses.at(-1).kind, 'hint');
  assert.equal((await f.state()).captureInFlight, null);
  assert.ok(f.warnings.every(value => value.message.startsWith('[basic-memory-bridge] ')));
  assert.ok(!JSON.stringify(f.warnings).includes('private'));
});

test('timeline notice failure does not prevent the accepted opportunity or duplicate it', async () => {
  const f = await fixture();
  f.session.log = async () => { throw new Error('synthetic-private-log-error'); };
  f.info({ totalTokens: 51000, limit: 200000 });
  await f.idle();
  assert.equal(f.sent.length, 1);
  assert.notEqual((await f.state()).captureInFlight, null);
  assert.equal(f.statuses.at(-1).label, 'queued');
  assert.ok(!JSON.stringify(f.logs).includes('synthetic-private'));
});

test('status publishing failure fails open without blocking capture', async () => {
  const f = await fixture();
  const bridge = new CaptureBridge({
    session: f.session, store: f.store, config: async () => defaults,
    log: async record => f.logs.push(record),
    status: async () => { throw new Error('private status failure'); }, clock: () => start,
  });
  await bridge.start();
  f.session.rpc.metadata.contextInfo = async () => ({ contextInfo: { totalTokens: 51000, limit: 200000 } });
  await bridge.on({ type: 'session.idle', data: {} });
  assert.equal(f.sent.length, 1);
  assert.ok(!JSON.stringify(f.logs).includes('private'));
});

test('compaction arriving during idle reservation cancels the unsent checkpoint without a notification', async () => {
  const f = await fixture();
  f.info({ totalTokens: 65000, limit: 100000 });
  f.session.rpc.metadata.activity = async () => {
    void f.event('session.compaction_start');
    return { hasActiveWork: false };
  };
  await f.idle();
  await f.event('session.compaction_complete', { success: true });
  assert.equal(f.sent.length, 0);
  assert.equal((await f.state()).captureInFlight, null);
  assert.equal(f.warnings.length, 0);
  assert.ok(f.logs.some(value => value.gateDecision === 'missed-pre-compaction'));
});

test('existing native state gains checkpoint history without resetting cadence or treating a startup baseline as a checkpoint', async () => {
  const f = await fixture();
  const state = await f.state();
  delete state.lastCheckpointTokens;
  delete state.lastCheckpointAt;
  state.lastOpportunityAt = start;
  state.lastOpportunityTokens = 123456;
  await writeFile(f.store.path, JSON.stringify(state));
  await f.reload();
  assert.equal((await f.state()).lastCheckpointTokens, 123456);
  assert.equal((await f.state()).lastOpportunityAt, start);
  const untouched = await fixture();
  const baseline = await untouched.state();
  delete baseline.lastCheckpointTokens;
  delete baseline.lastCheckpointAt;
  baseline.lastOpportunityTokens = 1000;
  await writeFile(untouched.store.path, JSON.stringify(baseline));
  await untouched.reload();
  assert.equal((await untouched.state()).lastCheckpointTokens, null);
});

test('active checkpoint retains the previous settled history until the new turn settles', async () => {
  const f = await fixture();
  await f.store.transaction(state => {
    state.lastCheckpointTokens = 198000;
    state.lastCheckpointAt = start - 3600000;
  });
  f.info({ totalTokens: 130000, limit: 200000 });
  await f.idle();
  assert.equal((await f.state()).lastCheckpointTokens, 198000);
  assert.equal(f.statuses.at(-1).prefix, 'last checkpoint: 198K, next checkpoint: ');
  assert.equal(f.statuses.at(-1).label, 'queued');
  await f.event('user.message', { messageId: 'message-1' });
  assert.equal(f.statuses.at(-1).prefix, 'last checkpoint: 198K, next checkpoint: ');
  assert.equal(f.statuses.at(-1).label, 'in progress');
  f.info({ totalTokens: 132000, limit: 200000 });
  await f.idle();
  assert.equal((await f.state()).lastCheckpointTokens, 132000);
});

test('forecast uses native compaction threshold and invalidates cached boundaries when the context tier changes', async () => {
  const f = await fixture({ periodicMinimumNewTokens: 150000 });
  f.info({ totalTokens: 51000, limit: 200000, compactionThreshold: 120000 });
  await f.idle();
  assert.equal(f.statuses.at(-1).tokenCeiling, 120000);
  await f.event('session.usage_info', { currentTokens: 52000, tokenLimit: 200000 });
  assert.equal(f.statuses.at(-1).tokenCeiling, 120000);
  await f.event('session.usage_info', { currentTokens: 52000, tokenLimit: 500000 });
  assert.equal(f.statuses.at(-1).tokenCeiling, 500000);
  f.info({ totalTokens: 52000, limit: 500000, compactionThreshold: 300000 });
  await f.idle();
  assert.equal(f.statuses.at(-1).tokenCeiling, 300000);
});

test('last checkpoint history survives context rebasing, compaction, and reload', async () => {
  const f = await fixture();
  f.info({ totalTokens: 51000, limit: 200000 });
  await f.idle();
  await f.event('user.message', { messageId: 'message-1' });
  f.info({ totalTokens: 53000, limit: 200000 });
  await f.idle();
  f.info({ totalTokens: 2000, limit: 200000 });
  await f.idle();
  assert.equal((await f.state()).lastOpportunityTokens, 2000);
  assert.equal((await f.state()).lastCheckpointTokens, 53000);
  await f.event('session.compaction_complete', { success: true });
  f.info({ totalTokens: 1000, limit: 200000 });
  await f.reload();
  assert.equal((await f.state()).lastCheckpointTokens, 53000);
});

test('session error and shutdown clear status without falsely releasing in-flight safety', async () => {
  const f = await fixture();
  f.info({ totalTokens: 51000, limit: 200000 });
  await f.idle();
  await f.event('session.error', { message: 'private error text' });
  assert.equal(f.statuses.at(-1), null);
  assert.notEqual((await f.state()).captureInFlight, null);
  await f.event('session.shutdown');
  assert.equal(f.statuses.at(-1), null);
  assert.ok(f.warnings.every(value => value.message.startsWith('[basic-memory-bridge] ')));
});

test('production config matches code defaults and native thresholds', async () => {
  assert.deepEqual(JSON.parse(await readFile(join(root, 'extension', 'config.json'), 'utf8')), defaults);
  assert.equal(defaults.periodicMinimumNewTokens, 50000);
  assert.equal(defaults.minimumMinutesBetweenOpportunities, 60);
  assert.equal(defaults.pressureMinimumMinutesBetweenOpportunities, 5);
  assert.equal(defaults.debugLogging, true);
});

test('cutover imports only the previous offer time, not byte watermarks', async () => {
  const directory = await mkdtemp(join(run, 'migration-'));
  const legacyDirectory = join(directory, 'legacy');
  const oldSessions = join(legacyDirectory, 'a'.repeat(64), 'sessions');
  await mkdir(oldSessions, { recursive: true });
  const hash = createHash('sha256').update('test-session').digest('hex');
  await writeFile(join(oldSessions, `${hash}.json`), JSON.stringify({
    sessionId: 'test-session', baselineTranscriptBytes: 9000000, lastCapturePromptBytes: 9500000,
    lastCapturePromptAt: new Date(start).toISOString(),
  }));
  const store = new FileStateStore(join(directory, 'native'), 'test-session', { legacyDirectory });
  await store.transaction(state => {
    assert.equal(state.lastOpportunityAt, start);
    assert.equal(state.lastOpportunityTokens, null);
    assert.equal(state.lastCheckpointAt, start);
    assert.equal(state.lastCheckpointTokens, null);
    applyUsage(state, { currentTokens: 1000, tokenLimit: 200000 }, defaults);
    assert.equal(statusContribution(state, { currentTokens: 1000, tokenLimit: 200000 }, defaults).labels.tokens,
      'last checkpoint: unknown, next checkpoint: {tokens}');
  });
  await store.transaction(state => {
    applyUsage(state, { currentTokens: 51000, tokenLimit: 200000 }, defaults);
    assert.equal(eligibility(state, defaults, start + 3599999), 'below-gate');
    assert.equal(eligibility(state, defaults, start + 3600000), 'periodic');
  });
});

for (const config of [null, [], { typo: true }, { periodicMinimumNewTokens: -1 },
  { contextPressureThreshold: 0 }, { contextPressureThreshold: 1.1 }, { debugLogging: 'true' },
  { minimumMinutesBetweenOpportunities: Infinity }, { recoverAfterCompaction: 'true' }]) {
  test(`invalid config rejects ${JSON.stringify(config)}`, () => assert.throws(() => validateConfig(config)));
}

test('startup baseline and short exchange do not prompt', async () => {
  const f = await fixture();
  await f.idle();
  assert.equal(f.sent.length, 0);
  assert.equal((await f.state()).baselineTokens, 1000);
});

test('periodic requires exact token delta and one-hour cooldown, not pressure', async () => {
  const f = await fixture();
  f.info({ totalTokens: 50999, limit: 200000 });
  await f.idle();
  assert.equal(f.sent.length, 0);
  f.info({ totalTokens: 51000, limit: 200000 });
  await f.idle();
  assert.equal(f.sent.length, 1);
  await f.event('user.message', { messageId: 'message-1', source: 'system' });
  f.info({ totalTokens: 53000, limit: 300000 });
  await f.idle();
  f.info({ totalTokens: 103000, limit: 300000 });
  f.time(start + 3600000 - 1);
  await f.idle();
  assert.equal(f.sent.length, 1);
  f.time(start + 3600000);
  await f.idle();
  assert.equal(f.sent.length, 2);
});

test('pressure is OR, honors five-minute gap, and offers only once per epoch', async () => {
  const f = await fixture();
  f.info({ totalTokens: 51000, limit: 200000 });
  await f.idle();
  await f.event('user.message', { messageId: 'message-1' });
  await f.idle();
  f.info({ totalTokens: 65000, limit: 100000 });
  f.time(start + 300000 - 1);
  await f.idle();
  assert.equal(f.sent.length, 1);
  f.time(start + 300000);
  await f.idle();
  assert.equal(f.sent.length, 2);
  assert.equal((await f.state()).pressureOpportunityEpoch, 0);
  await f.event('user.message', { messageId: 'message-2' });
  await f.idle();
  f.time(start + 600000);
  await f.idle();
  assert.equal(f.sent.length, 2);
});

test('checkpoint activity is excluded and its own idle never reenters', async () => {
  const f = await fixture({ periodicMinimumNewTokens: 0, minimumMinutesBetweenOpportunities: 0 });
  await f.idle();
  await f.event('user.message', { messageId: 'message-1' });
  f.info({ totalTokens: 99000, limit: 200000 });
  await f.idle();
  assert.equal(f.sent.length, 1);
  assert.equal((await f.state()).lastOpportunityTokens, 99000);
  assert.equal((await f.state()).captureInFlight, null);
});

test('no native data skips even when persisted usage would qualify', async () => {
  const f = await fixture();
  f.info({ totalTokens: 65000, limit: 100000 });
  await f.event('session.usage_info', { currentTokens: 65000, tokenLimit: 100000, messagesLength: 10 });
  f.info(null);
  await f.idle();
  assert.equal(f.sent.length, 0);
  assert.equal(f.logs.at(-1).gateDecision, 'usage-unavailable');
});

test('on-demand refresh preserves the last native message count', async () => {
  const f = await fixture();
  await f.event('session.usage_info', { currentTokens: 1000, tokenLimit: 200000, messagesLength: 7 });
  await f.idle();
  assert.equal((await f.state()).lastSeenMessagesLength, 7);
  assert.ok(f.logs.some(row => row.event === 'session.usage_info' && row.gateDecision === 'usage-observed'));
});

test('aborted, subagent, busy and disabled idles do not send', async () => {
  const f = await fixture();
  f.info({ totalTokens: 65000, limit: 100000 });
  await f.idle(true);
  await f.event('session.idle', {}, { agentId: 'child' });
  f.active(true);
  await f.idle();
  f.active(false);
  f.config({ enabled: false });
  await f.idle();
  assert.equal(f.sent.length, 0);
});

test('failed send retries only after short backoff, without consuming pressure epoch', async () => {
  const f = await fixture();
  f.info({ totalTokens: 65000, limit: 100000 });
  f.session.send = async () => { throw new Error('synthetic private error must not leak'); };
  await f.idle();
  assert.equal((await f.state()).lastOpportunityAt, null);
  assert.equal((await f.state()).pressureOpportunityEpoch, null);
  assert.equal((await f.state()).captureInFlight, null);
  f.session.send = async message => { f.sent.push(message); return 'retried'; };
  f.time(start + 59999);
  await f.idle();
  assert.equal(f.sent.length, 0);
  f.time(start + 60000);
  await f.idle();
  assert.equal(f.sent.length, 1);
  assert.ok(!JSON.stringify([f.logs, f.warnings]).includes('private error'));
});

test('reservation is not an opportunity until the SDK accepts the send', async () => {
  const f = await fixture();
  f.info({ totalTokens: 65000, limit: 100000 });
  let entered;
  let accept;
  const sending = new Promise(resolve => { entered = resolve; });
  f.session.send = async options => {
    f.sent.push(options);
    entered();
    return new Promise(resolve => { accept = resolve; });
  };
  const idle = f.idle();
  await sending;
  const reserved = await f.state();
  assert.equal(reserved.lastOpportunityAt, null);
  assert.equal(reserved.pressureOpportunityEpoch, null);
  assert.notEqual(reserved.captureInFlight, null);
  accept('accepted-message');
  await idle;
  assert.equal((await f.state()).lastOpportunityAt, start);
  assert.equal((await f.state()).pressureOpportunityEpoch, 0);
});

test('unconfirmed reservation on resume does not claim a delivered opportunity', async () => {
  const f = await fixture();
  await f.store.transaction(state => {
    state.captureInFlight = { id: 'pending-request', kind: 'periodic', epoch: 0, messageId: null, started: false };
  });
  await f.reload();
  await f.idle();
  const state = await f.state();
  assert.equal(state.captureInFlight, null);
  assert.equal(state.lastOpportunityAt, null);
  assert.equal(state.retryAfter, start + 60000);
});

test('native receipt reconciles an accepted request whose state acknowledgement failed', async () => {
  const f = await fixture();
  f.info({ totalTokens: 65000, limit: 100000 });
  const transaction = f.store.transaction.bind(f.store);
  let writes = 0;
  f.store.transaction = action => {
    writes += 1;
    if (writes === 2) return Promise.reject(new Error('synthetic state acknowledgement failure'));
    return transaction(action);
  };
  await f.idle();
  assert.equal(f.sent.length, 1);
  assert.equal((await f.state()).lastOpportunityAt, null);
  await f.event('user.message', { source: 'system', messageId: 'message-1', content: f.sent[0].displayPrompt });
  assert.equal((await f.state()).lastOpportunityAt, start);
  await f.idle();
  assert.equal(f.sent.length, 1);
  assert.equal((await f.state()).captureInFlight, null);
});

test('compaction after an undelivered steering request still queues a distinct read-only recovery', async () => {
  const f = await fixture();
  await f.event('session.usage_info', { currentTokens: 70000, tokenLimit: 100000 });
  await f.event('session.compaction_start');
  await f.event('session.compaction_complete', { success: true });
  f.info({ totalTokens: 10000, limit: 100000 });
  await f.idle();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].mode, 'immediate');
  assert.match(f.sent[1].displayPrompt, /^Basic Memory recovery:/);
  assert.equal((await f.state()).lastOpportunityAt, start);
  assert.equal((await f.state()).compactionEpoch, 1);
  assert.equal((await f.state()).baselineTokens, 10000);
  assert.ok(f.logs.some(row => row.gateDecision === 'missed-pre-compaction'));
});

test('only own queued checkpoint is cancelled when compaction starts', async () => {
  const f = await fixture();
  f.info({ totalTokens: 65000, limit: 100000 });
  await f.idle();
  f.pending([{ id: 'own-item', messageId: 'message-1' }, { id: 'user-item', messageId: 'human-message' }]);
  await f.event('session.compaction_start');
  assert.deepEqual(f.removed, ['own-item']);
  assert.equal((await f.state()).captureInFlight, null);
});

test('absolute 70% pressure permits one steering request after compaction without a growth gate', async () => {
  const f = await fixture({ recoverAfterCompaction: false });
  await f.event('session.compaction_start');
  await f.event('session.compaction_complete', { success: true });
  f.info({ totalTokens: 70000, limit: 100000 });
  await f.idle();
  f.time(start + 3600000);
  await f.idle();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].mode, 'immediate');
  f.info({ totalTokens: 71000, limit: 100000 });
  await f.idle();
  assert.equal(f.sent.length, 1, JSON.stringify({ state: await f.state(), logs: f.logs, notices: f.warnings }));
});

test('queued user work prevents an idle checkpoint', async () => {
  const f = await fixture();
  f.info({ totalTokens: 65000, limit: 100000 });
  f.pending([{ id: 'human-item', messageId: 'human-message' }]);
  await f.idle();
  assert.equal(f.sent.length, 0);
});

test('native RPC failure skips capture and recovers when readings return', async () => {
  const f = await fixture();
  f.session.rpc.metadata.contextInfo = async () => { throw new Error('private rpc payload'); };
  await f.idle();
  assert.equal(f.sent.length, 0);
  assert.ok(f.warnings.length > 0);
  assert.ok(!JSON.stringify([f.logs, f.warnings]).includes('private rpc payload'));
  f.session.rpc.metadata.contextInfo = async () => ({ contextInfo: { totalTokens: 51000, limit: 200000 } });
  await f.idle();
  assert.equal(f.sent.length, 1);
});

test('successful compaction defers one recovery to safe idle and leaves checkpoint accounting unchanged', async () => {
  const f = await fixture();
  await f.store.transaction(state => {
    state.lastOpportunityAt = start - 1000;
    state.lastCheckpointAt = start - 500;
    state.lastCheckpointTokens = 90000;
    state.pressureOpportunityEpoch = 0;
  });
  await f.event('session.compaction_complete', { success: true });
  const pending = await f.state();
  assert.equal(f.sent.length, 0);
  assert.equal(pending.pendingRecoveryEpoch, 1);
  assert.match(f.statuses.at(-1).label, /state recovery: awaiting idle/);
  f.info({ totalTokens: 10000, limit: 100000 });
  f.active(true);
  await f.idle();
  assert.equal(f.sent.length, 0);
  f.active(false);
  f.pending([{ id: 'user-work', messageId: 'human-message' }]);
  await f.idle();
  assert.equal(f.sent.length, 0);
  f.pending([]);
  await f.idle();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].source, 'system');
  assert.equal(f.sent[0].mode, 'enqueue');
  const queued = await f.state();
  assert.equal(queued.pendingRecoveryEpoch, null);
  assert.equal(queued.captureInFlight.kind, 'recovery');
  assert.equal(queued.lastCheckpointAt, pending.lastCheckpointAt);
  assert.equal(queued.lastOpportunityAt, pending.lastOpportunityAt);
  assert.equal(queued.lastCheckpointTokens, pending.lastCheckpointTokens);
  assert.equal(queued.pressureOpportunityEpoch, pending.pressureOpportunityEpoch);
  assert.equal(f.statuses.at(-1).prefix, 'last checkpoint: 90K, state recovery: ');
  assert.equal(f.statuses.at(-1).label, 'queued');
  assert.equal(f.warnings.at(-1).message, '[basic-memory-bridge] State recovery queued');
  await f.event('user.message', { messageId: 'message-1' });
  assert.equal(f.statuses.at(-1).label, 'in progress');
  f.info({ totalTokens: 80000, limit: 100000 });
  await f.idle();
  const finished = await f.state();
  assert.equal(finished.captureInFlight, null);
  assert.equal(finished.baselineTokens, 80000);
  assert.equal(finished.lastOpportunityAt, pending.lastOpportunityAt);
  assert.equal(finished.lastCheckpointAt, pending.lastCheckpointAt);
  assert.equal(finished.lastCheckpointTokens, pending.lastCheckpointTokens);
  assert.equal(finished.pressurePending, false);
  await f.idle();
  assert.equal(f.sent.length, 2, 'Recovery excludes periodic growth, not the new absolute emergency percentage.');
  assert.equal((await f.state()).captureInFlight.kind, 'emergency');
  assert.equal(f.sent[1].mode, 'enqueue');
  assert.equal(f.aborts.length, 0, 'An already idle session needs no cancellation.');
});

test('recovery prompt uses the exact same-thread local lookup and prohibits note mutation', () => {
  const prompt = recoveryPrompt('recovery-session');
  assert.match(prompt, /metadata_filters.thread_id = "copilot:recovery-session"/);
  assert.match(prompt, /most recent existing Basic Memory capture/);
  assert.match(prompt, /read-only recovery/);
  assert.match(prompt, /do not create, update, move or delete notes/);
  assert.match(prompt, /newer conversation instructions/);
  assert.match(prompt, /skip recovery/);
  assert.throws(() => recoveryPrompt('../other'), /session-invalid/);
});

test('duplicate compaction completion and reload do not duplicate a recovery request', async () => {
  const f = await fixture();
  const id = 'successful-compaction';
  await f.event('session.compaction_complete', { success: true }, { id });
  await f.reload();
  assert.equal((await f.state()).pendingRecoveryEpoch, 1);
  f.info({ totalTokens: 10000, limit: 100000 });
  await f.idle();
  f.pending([{ id: 'recovery-item', messageId: 'message-1' }]);
  await f.reload();
  await f.idle();
  assert.equal(f.sent.length, 1);
  await f.event('session.compaction_complete', { success: true }, { id });
  f.pending([]);
  await f.event('user.message', { messageId: 'message-1' });
  await f.idle();
  await f.idle();
  assert.equal(f.sent.length, 1);
  assert.equal((await f.state()).compactionEpoch, 1);
});

test('failed compaction, child compaction, context clear and lower native counts do not request recovery', async () => {
  for (const event of [
    ['session.compaction_complete', { success: false }, {}],
    ['session.compaction_complete', { success: true }, { agentId: 'child' }],
    ['session.context_cleared', {}, {}],
  ]) {
    const f = await fixture();
    await f.event(...event);
    f.info({ totalTokens: 500, limit: 100000 });
    await f.idle();
    assert.equal(f.sent.length, 0);
    assert.equal((await f.state()).pendingRecoveryEpoch, null);
  }
});

test('disabled recovery still permits normal periodic captures and clears unsent reminders', async () => {
  const f = await fixture({ recoverAfterCompaction: false });
  await f.event('session.compaction_complete', { success: true });
  f.info({ totalTokens: 10000, limit: 200000 });
  await f.idle();
  assert.equal(f.sent.length, 0);
  f.info({ totalTokens: 60000, limit: 200000 });
  await f.idle();
  assert.match(f.sent[0].displayPrompt, /^Basic Memory checkpoint:/);
  const paused = await fixture();
  await paused.event('session.compaction_complete', { success: true });
  paused.config({ enabled: false });
  await paused.idle();
  assert.equal((await paused.state()).pendingRecoveryEpoch, null);
  assert.equal(paused.sent.length, 0);
});

test('aborted idle cancels the unsent recovery instead of reviving work after cancellation', async () => {
  const f = await fixture();
  await f.event('session.compaction_complete', { success: true });
  await f.idle(true);
  await f.idle();
  assert.equal(f.sent.length, 0);
  assert.equal((await f.state()).pendingRecoveryEpoch, null);
});

test('review recovery regression: interruption during the processing read stops startup and completion recovery', async t => {
  for (const trigger of ['reload', 'compaction']) {
    await t.test(trigger, async () => {
      const f = await fixture();
      if (trigger === 'reload') await f.store.transaction(state => {
        state.compactionEpoch = 1;
        state.pendingRecoveryEpoch = 1;
      });
      f.processing(false);
      let release;
      let entered;
      const reading = new Promise(resolve => { entered = resolve; });
      f.session.rpc.metadata.isProcessing = () => new Promise(resolve => {
        release = resolve;
        entered();
      });
      const recovery = trigger === 'reload' ? f.reload() : f.event('session.compaction_complete', { success: true });
      await reading;
      const interrupted = f.idle(true);
      release({ processing: false });
      await Promise.all([recovery, interrupted]);
      assert.equal(f.sent.length, 0);
      assert.equal(f.aborts.length, 0);
      assert.equal((await f.state()).captureInFlight, null);
      assert.equal((await f.state()).pendingRecoveryEpoch, null);
      assert.equal((await f.state()).pressureEscalationPaused, true);
    });
  }
});

test('review recovery regression: interruption during recovery admission cannot create an automated turn', async t => {
  for (const [group, method] of [['metadata', 'contextInfo'], ['metadata', 'activity'], ['queue', 'pendingItems']]) {
    await t.test(`${group}.${method}`, async () => {
      const f = await fixture();
      f.processing(false);
      let release;
      let entered;
      const reading = new Promise(resolve => { entered = resolve; });
      const original = f.session.rpc[group][method];
      f.session.rpc[group][method] = () => {
        f.session.rpc[group][method] = original;
        return new Promise(resolve => {
          release = async () => resolve(await original());
          entered();
        });
      };
      const recovery = f.event('session.compaction_complete', { success: true });
      await reading;
      const interrupted = f.idle(true);
      await release();
      await Promise.all([recovery, interrupted]);
      assert.equal(f.sent.length, 0);
      assert.equal(f.aborts.length, 0);
      assert.equal((await f.state()).captureInFlight, null);
      assert.equal((await f.state()).pendingRecoveryEpoch, null);
      assert.equal((await f.state()).pressureEscalationPaused, true);
    });
  }
});

test('review recovery regression: interruption after reservation still prevents the recovery send', async () => {
  const f = await fixture();
  await f.store.transaction(state => {
    state.compactionEpoch = 1;
    state.pendingRecoveryEpoch = 1;
  });
  f.processing(false);
  let release;
  let entered;
  let held = false;
  const publishing = new Promise(resolve => { entered = resolve; });
  const bridge = new CaptureBridge({
    session: f.session, store: f.store, config: async () => defaults,
    log: async row => f.logs.push(row), clock: () => start,
    status: async () => {
      if (!held && bridge.lastState?.captureInFlight?.kind === 'recovery') {
        held = true;
        await new Promise(resolve => { release = resolve; entered(); });
      }
    },
  });
  const recovery = bridge.start();
  await publishing;
  const interrupted = bridge.on({ type: 'session.idle', data: { aborted: true } });
  release();
  await Promise.all([recovery, interrupted]);
  assert.equal(f.sent.length, 0);
  assert.equal(f.aborts.length, 0);
  assert.equal((await f.state()).captureInFlight, null);
  assert.equal((await f.state()).pendingRecoveryEpoch, null);
  assert.equal((await f.state()).pressureEscalationPaused, true);
});

test('failed recovery send is reported once per compaction without consuming capture clocks', async () => {
  const f = await fixture();
  await f.event('session.compaction_complete', { success: true });
  let attempts = 0;
  f.session.send = async () => { attempts += 1; throw new Error('private recovery failure'); };
  await f.idle();
  await f.idle();
  assert.equal(attempts, 1);
  const state = await f.state();
  assert.equal(state.lastOpportunityAt, null);
  assert.equal(state.lastCheckpointAt, null);
  assert.equal(state.retryAfter, null);
  assert.equal(state.pendingRecoveryEpoch, null);
  assert.match(f.warnings.at(-1).message, /recovery-send failed/);
  assert.ok(!JSON.stringify(f.warnings).includes('private recovery'));
});

test('a pending checkpoint is reconciled before admitting post-compaction recovery', async () => {
  const f = await fixture();
  f.info({ totalTokens: 51000, limit: 200000 });
  await f.idle();
  await f.event('user.message', { messageId: 'message-1' });
  await f.event('session.compaction_complete', { success: true });
  f.info({ totalTokens: 10000, limit: 200000 });
  await f.idle();
  assert.equal(f.sent.length, 2);
  assert.equal((await f.state()).captureInFlight.kind, 'recovery');
});

test('legacy state without recovery metadata migrates without discarding history', async () => {
  const f = await fixture();
  const state = await f.state();
  delete state.pendingRecoveryEpoch;
  state.lastCheckpointTokens = 198000;
  state.lastCheckpointAt = start - 1000;
  await writeFile(f.store.path, JSON.stringify(state));
  await f.reload();
  assert.equal((await f.state()).pendingRecoveryEpoch, null);
  assert.equal((await f.state()).lastCheckpointTokens, 198000);
  assert.equal((await f.state()).lastCheckpointAt, start - 1000);
  assert.equal(f.sent.length, 0);
});

test('manual compaction while already idle admits recovery without another user turn or idle event', async () => {
  const f = await fixture();
  f.processing(false);
  await f.event('session.compaction_complete', { success: true });
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].displayPrompt, /^Basic Memory recovery:/);
  assert.equal((await f.state()).captureInFlight.kind, 'recovery');
  assert.equal((await f.state()).pendingRecoveryEpoch, null);
  assert.equal((await f.state()).lastOpportunityAt, null);
  assert.ok(f.logs.some(row => row.event === 'bridge.recovery_check' && row.gateDecision === 'offered:recovery'));
});

test('post-compaction check never uses a model turn end as proof of idle', async () => {
  const f = await fixture();
  await f.event('session.compaction_complete', { success: true });
  await f.event('assistant.turn_end');
  assert.equal(f.sent.length, 0);
  assert.equal((await f.state()).pendingRecoveryEpoch, 1);
  assert.ok(f.logs.some(row => row.gateDecision === 'recovery-awaiting-idle'));
  f.processing(false);
  await f.idle();
  assert.equal(f.sent.length, 1);
});

test('already-idle check still yields to background tasks and queued foreground work', async () => {
  for (const kind of ['active', 'queued']) {
    const f = await fixture();
    f.processing(false);
    if (kind === 'active') f.active(true);
    else f.pending([{ id: 'human-request', messageId: 'user-message' }]);
    await f.event('session.compaction_complete', { success: true });
    assert.equal(f.sent.length, 0);
    assert.equal((await f.state()).pendingRecoveryEpoch, 1);
    f.active(false);
    f.pending([]);
    await f.idle();
    assert.equal(f.sent.length, 1);
  }
});

test('resuming an unsent pending recovery while already idle does not need a new user prompt', async () => {
  const f = await fixture();
  await f.event('session.compaction_complete', { success: true });
  f.processing(false);
  await f.reload();
  assert.equal(f.sent.length, 1);
  f.pending([{ id: 'accepted', messageId: 'message-1' }]);
  await f.reload();
  assert.equal(f.sent.length, 1);
});

test('failed or invalid native processing query retains recovery and cannot trigger a send', async () => {
  for (const response of [null, { processing: 'false' }]) {
    const f = await fixture();
    f.session.rpc.metadata.isProcessing = async () => {
      if (response === null) throw new Error('private-native-error');
      return response;
    };
    await f.event('session.compaction_complete', { success: true });
    assert.equal(f.sent.length, 0);
    assert.equal((await f.state()).pendingRecoveryEpoch, 1);
    assert.ok(f.logs.some(row => row.gateDecision === 'event-error'));
    assert.ok(!JSON.stringify(f.warnings).includes('private-native-error'));
    f.session.rpc.metadata.isProcessing = async () => ({ processing: false });
    await f.idle();
    assert.equal(f.sent.length, 1);
  }
});

test('already-idle path honors cancellation, disabled recovery and repeated completion deduplication', async () => {
  const f = await fixture();
  await f.event('session.compaction_complete', { success: true }, { id: 'manual-event' });
  await f.idle(true);
  f.processing(false);
  await f.event('session.compaction_complete', { success: true }, { id: 'manual-event' });
  assert.equal(f.sent.length, 0);
  f.config({ recoverAfterCompaction: false, periodicMinimumNewTokens: 0 });
  await f.event('session.compaction_complete', { success: true }, { id: 'other-manual-event' });
  assert.equal(f.sent.length, 0, 'The new check must not turn into a periodic checkpoint.');
});

test('recovery excludes its own growth while retaining genuine progress accrued before its turn', async () => {
  const f = await fixture();
  await f.event('session.compaction_complete', { success: true });
  f.active(true);
  f.info({ totalTokens: 10000, limit: 200000 });
  await f.idle();
  f.info({ totalTokens: 20000, limit: 200000 });
  f.active(false);
  await f.idle();
  await f.event('user.message', { messageId: 'message-1' });
  f.info({ totalTokens: 30000, limit: 200000 });
  await f.idle();
  const state = await f.state();
  assert.equal(state.lastContextTokens - state.baselineTokens, 10000);
  assert.equal(state.lastOpportunityAt, null);
  assert.equal(state.lastCheckpointAt, null);
});

test('multiple pending compactions coalesce and a new compaction during recovery permits only the newer recovery', async () => {
  const f = await fixture();
  await f.event('session.compaction_complete', { success: true }, { id: 'first' });
  await f.event('session.compaction_complete', { success: true }, { id: 'second' });
  await f.idle();
  assert.equal(f.sent.length, 1);
  assert.equal((await f.state()).captureInFlight.epoch, 2);
  await f.event('user.message', { messageId: 'message-1' });
  await f.event('session.compaction_complete', { success: true }, { id: 'third' });
  await f.idle();
  assert.equal(f.sent.length, 2);
  assert.equal((await f.state()).captureInFlight.epoch, 3);
  assert.equal((await f.state()).lastCheckpointAt, null);
});

test('accepted recovery survives an acknowledgement persistence failure without claiming a checkpoint', async () => {
  const f = await fixture();
  await f.event('session.compaction_complete', { success: true });
  const transaction = f.store.transaction.bind(f.store);
  let writes = 0;
  f.store.transaction = action => ++writes === 2 ? Promise.reject(new Error('synthetic acknowledgement failure')) : transaction(action);
  await f.idle();
  assert.equal(f.sent.length, 1);
  await f.event('user.message', { source: 'system', messageId: 'message-1', content: f.sent[0].displayPrompt });
  await f.idle();
  await f.idle();
  assert.equal(f.sent.length, 1);
  assert.equal((await f.state()).lastOpportunityAt, null);
  assert.equal((await f.state()).lastCheckpointAt, null);
});

test('a new compaction racing recovery admission cancels the unsent recovery without a checkpoint notice', async () => {
  const f = await fixture();
  await f.event('session.compaction_complete', { success: true });
  f.session.rpc.metadata.activity = async () => {
    void f.event('session.compaction_start');
    return { hasActiveWork: false };
  };
  await f.idle();
  assert.equal(f.sent.length, 0);
  assert.equal((await f.state()).captureInFlight, null);
  assert.equal(f.warnings.length, 0);
  assert.ok(f.logs.some(row => row.gateDecision === 'recovery-deferred-compaction'));
});

test('failed initialization does not prompt until it can establish the native baseline', async () => {
  const f = await fixture();
  f.session.rpc.metadata.snapshot = async () => { throw new Error('snapshot failure'); };
  await f.reload();
  f.info({ totalTokens: 51000, limit: 200000 });
  await f.idle();
  assert.equal(f.sent.length, 0);
  f.session.rpc.metadata.snapshot = async () => ({ workingDirectory: f.directory, isRemote: false, clientName: 'copilot-cli' });
  await f.idle();
  assert.equal(f.sent.length, 1);
});

test('snapshot failure records its operation and safe RPC code, then retries initialization without duplicate capture', async () => {
  const f = await fixture();
  const snapshot = f.session.rpc.metadata.snapshot;
  f.logs.length = 0;
  f.session.rpc.metadata.snapshot = async () => {
    throw Object.assign(new Error('private-native-error'), { code: -32601, data: 'private-response' });
  };
  await f.reload();
  const failed = f.logs.find(row => row.gateDecision === 'event-error');
  assert.equal(failed.phase, 'initialization');
  assert.equal(failed.operation, 'metadata.snapshot');
  assert.equal(failed.code, -32601);
  assert.equal(failed.errorType, 'Error');
  assert.match(f.warnings.at(-1).message, /metadata.snapshot: -32601/);
  assert.ok(!f.logs.some(row => row.gateDecision === 'attached'));
  f.info({ totalTokens: 51000, limit: 200000 });
  await f.idle();
  assert.equal(f.sent.length, 0);
  assert.ok(!JSON.stringify([f.logs, f.warnings]).includes('private'));
  f.session.rpc.metadata.snapshot = snapshot;
  await f.idle();
  await f.idle();
  assert.equal(f.sent.length, 1);
  assert.ok(f.logs.some(row => row.gateDecision === 'attached'));
});

test('invalid snapshot response retains the failing operation without exposing exception text', async () => {
  const f = await fixture();
  f.session.rpc.metadata.snapshot = async () => { throw new TypeError('private-invalid-snapshot'); };
  await f.reload();
  const failed = f.logs.findLast(row => row.gateDecision === 'event-error');
  assert.equal(failed.operation, 'metadata.snapshot');
  assert.equal(failed.errorType, 'TypeError');
  assert.equal(failed.code, 'UNKNOWN');
  assert.ok(!JSON.stringify(f.logs).includes('Cannot read'));
});

test('failed compaction clears busy guard without advancing epoch', async () => {
  const f = await fixture();
  await f.event('session.compaction_start');
  await f.event('session.compaction_complete', { success: false });
  assert.equal((await f.state()).compactionEpoch, 0);
  assert.equal((await f.state()).compacting, false);
});

test('already offered pressure checkpoint is not falsely reported as missed', async () => {
  const f = await fixture();
  f.info({ totalTokens: 65000, limit: 100000 });
  await f.idle();
  await f.event('user.message', { messageId: 'message-1' });
  await f.idle();
  await f.event('session.compaction_start');
  assert.ok(!f.logs.some(row => row.gateDecision === 'missed-pre-compaction'));
  assert.equal(f.logs.at(-1).gateDecision, 'compaction-start');
});

test('reload reconciles completed request and preserves cooldown and watermark', async () => {
  const f = await fixture();
  f.info({ totalTokens: 51000, limit: 200000 });
  await f.idle();
  await f.reload();
  f.info({ totalTokens: 60000, limit: 200000 });
  await f.idle();
  assert.equal(f.sent.length, 1);
  assert.equal((await f.state()).captureInFlight, null);
  assert.equal((await f.state()).lastOpportunityTokens, 51000);
  await f.idle();
  assert.equal(f.sent.length, 1);
});

test('reload immediately clears detached stale progress, but preserves a still-running checkpoint', async () => {
  const f = await fixture();
  f.info({ totalTokens: 51000, limit: 200000 });
  await f.idle();
  await f.event('user.message', { messageId: 'message-1' });
  f.active(true);
  await f.reload();
  assert.equal(f.statuses.at(-1).label, 'in progress');
  f.active(false);
  await f.reload();
  assert.equal(f.statuses.at(-1).kind, 'hint');
  assert.equal((await f.state()).captureInFlight, null);
});

test('another consumed logical turn clears old progress, while immediate steering does not', async () => {
  const f = await fixture();
  f.info({ totalTokens: 51000, limit: 200000 });
  await f.idle();
  await f.event('user.message', { messageId: 'message-1' });
  await f.event('user.message', { messageId: 'human-steer', delivery: 'steering' });
  assert.equal(f.statuses.at(-1).label, 'in progress');
  await f.event('user.message', { messageId: 'new-turn', delivery: 'idle' });
  assert.equal(f.statuses.at(-1).kind, 'hint');
  assert.equal((await f.state()).captureInFlight, null);
});

test('reload rebases lower tokens without inventing a missed compaction or recovery', async () => {
  const f = await fixture();
  f.info({ totalTokens: 65000, limit: 100000 });
  await f.idle();
  await f.event('user.message', { messageId: 'message-1' });
  await f.idle();
  f.info({ totalTokens: 10000, limit: 100000 });
  await f.reload();
  assert.equal((await f.state()).compactionEpoch, 0);
  assert.equal((await f.state()).baselineTokens, 10000);
  await f.idle();
  assert.equal(f.sent.length, 1);
  assert.equal((await f.state()).pendingRecoveryEpoch, null);
  assert.equal((await f.state()).pressureOpportunityEpoch, 0);
  assert.equal((await f.state()).lastOpportunityAt, start);
});

test('context cleared resets baseline and preserves stable thread identity', async () => {
  const f = await fixture();
  await f.event('session.context_cleared');
  f.info({ totalTokens: 100, limit: 200000 });
  await f.idle();
  assert.equal((await f.state()).baselineTokens, 100);
  assert.match(checkpointPrompt(f.session.sessionId), /copilot:test-session/);
});

test('decreasing context cannot masquerade as new activity', () => {
  const s = freshState('test');
  const c = validateConfig({});
  applyUsage(s, { currentTokens: 100000, tokenLimit: 300000 }, c);
  applyUsage(s, { currentTokens: 1000, tokenLimit: 300000 }, c);
  assert.equal(eligibility(s, c, start), 'below-gate');
});

test('multiple sessions have isolated state and opportunities', async () => {
  const [a, b] = await Promise.all([fixture({}, 'session-a'), fixture({}, 'session-b')]);
  a.info({ totalTokens: 51000, limit: 200000 });
  await Promise.all([a.idle(), b.idle()]);
  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 0);
});

test('corrupt state recovers with baseline and no recovery-stop prompt', async () => {
  const f = await fixture();
  await writeFile(f.store.path, '{broken');
  f.info({ totalTokens: 65000, limit: 100000 });
  await f.idle();
  assert.equal(f.sent.length, 0);
  assert.equal((await f.state()).baselineTokens, 65000);
});

test('busy lock fails open without stealing another owner lock', async () => {
  const f = await fixture();
  await writeFile(`${f.store.path}.lock`, 'owner');
  f.info({ totalTokens: 51000, limit: 200000 });
  await f.idle();
  assert.equal(f.sent.length, 0);
  assert.equal(await readFile(`${f.store.path}.lock`, 'utf8'), 'owner');
  const failed = f.logs.findLast(row => row.gateDecision === 'event-error');
  assert.equal(failed.operation, 'state.lock-acquire');
  assert.equal(failed.code, 'EEXIST');
  assert.equal(failed.phase, 'event');
  assert.ok(!JSON.stringify([f.logs, f.warnings]).includes(f.directory));
});

test('diagnostic codes are allowlisted even when nested errors contain private fields', () => {
  const privateError = Object.assign(new Error('private-message'), {
    name: 'private-type', code: 'private-code', operation: 'private-operation', stack: 'private-stack',
  });
  assert.deepEqual(bridgeDiagnostic(privateError), {
    operation: 'unknown', code: 'UNKNOWN', errorType: 'UNKNOWN',
  });
  const nested = new Error('private-wrapper', { cause: Object.assign(new Error('private-cause'), { code: 'EACCES' }) });
  assert.deepEqual(bridgeDiagnostic(nested), {
    operation: 'unknown', code: 'EACCES', errorType: 'Error',
  });
  assert.equal(bridgeDiagnostic(new Error('rpc-timeout')).code, 'RPC_TIMEOUT');
});

test('bounded diagnostics contain only allowed operational fields', async () => {
  const directory = await mkdtemp(join(run, 'logs-'));
  const logger = createLogger(directory, 'test-session', () => start);
  await logger.ready;
  const record = { event: 'session.idle', gateDecision: 'below-gate', contextRatio: 0.2,
    prompt: 'synthetic-secret', cwd: 'private-path', toolResult: 'private-result' };
  await logger(record);
  await logger(record);
  await settleLogger(logger);
  const text = await readFile(join(directory, 'test-session.jsonl'), 'utf8');
  const rows = text.trim().split('\n');
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(rows[0])).sort(), ['contextRatio', 'event', 'gateDecision', 'sessionId', 'timestamp'].sort());
  assert.ok(!text.includes('private'));
  assert.ok(!text.includes('synthetic-secret'));
});

test('persisted failures retain safe details and do not throttle different operations or codes together', async () => {
  const directory = await mkdtemp(join(run, 'failure-logs-'));
  const logger = createLogger(directory, 'test-session', () => start);
  await logger.ready;
  const record = {
    event: 'bridge', gateDecision: 'event-error', phase: 'initialization',
    operation: 'metadata.snapshot', code: -32601, errorType: 'Error',
    message: 'private-message', stack: 'private-stack', path: 'private-path',
  };
  await logger(record);
  await logger(record);
  await logger({ ...record, operation: 'state.lock-acquire', code: 'EEXIST' });
  await logger({ ...record, code: 'RPC_TIMEOUT' });
  await logger({ ...record, operation: 'private-operation', code: 'private-code', errorType: 'private-type' });
  await settleLogger(logger);
  const text = await readFile(join(directory, 'test-session.jsonl'), 'utf8');
  const rows = text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], {
    timestamp: new Date(start).toISOString(), sessionId: 'test-session',
    event: 'bridge', gateDecision: 'event-error', phase: 'initialization',
    operation: 'metadata.snapshot', code: -32601, errorType: 'Error',
  });
  assert.equal(rows[1].operation, 'state.lock-acquire');
  assert.equal(rows[2].code, 'RPC_TIMEOUT');
  assert.equal(rows[3].operation, 'unknown');
  assert.equal(rows[3].code, 'UNKNOWN');
  assert.equal(rows[3].errorType, 'UNKNOWN');
  assert.ok(!text.includes('private'));
});

test('a failed diagnostic writer falls back to safe stderr without breaking later events', async t => {
  const f = await fixture();
  const stderr = [];
  t.mock.method(console, 'error', value => stderr.push(JSON.parse(value)));
  const bridge = new CaptureBridge({
    session: f.session, store: f.store, config: async () => defaults,
    log: async () => { throw Object.assign(new Error('private-log-path'), { code: 'EACCES' }); },
    clock: () => start,
  });
  f.session.rpc.metadata.snapshot = async () => {
    throw Object.assign(new Error('private-rpc-data'), { code: -32601 });
  };
  await bridge.start();
  assert.equal(stderr.at(-1).operation, 'metadata.snapshot');
  assert.equal(stderr.at(-1).code, -32601);
  assert.deepEqual(stderr.at(-1).diagnosticFailure, {
    operation: 'diagnostic.write', code: 'EACCES', errorType: 'Error',
  });
  assert.ok(!JSON.stringify(stderr).includes('private'));
  await bridge.on({ type: 'session.usage_info', data: { currentTokens: 1000, tokenLimit: 200000 } });
});

test('state filenames reject traversal and state contains no context/prompt text', async () => {
  for (const id of ['..', '..\\escape', 'bad/id', '']) assert.throws(() => new FileStateStore(run, id));
  const f = await fixture();
  await f.event('session.context_changed', { cwd: 'private-context', branch: 'private-branch' });
  const content = await readFile(f.store.path, 'utf8');
  assert.ok(!content.includes('private'));
  assert.equal((await readdir(join(f.directory, 'sessions'))).filter(name => name.endsWith('.json')).length, 1);
});
