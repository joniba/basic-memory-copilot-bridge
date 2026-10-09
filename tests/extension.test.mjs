import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  applyUsage, CaptureBridge, checkpointPrompt, createLogger, defaults,
  eligibility, FileStateStore, freshState, validateConfig,
  statusContribution,
} from '../extension/bridge.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifacts = join(root, '.test-artifacts');
await mkdir(artifacts, { recursive: true });
const run = await mkdtemp(join(artifacts, 'extension-unit-'));
const start = Date.parse('2026-10-08T10:00:00Z');

async function fixture(overrides = {}, id = 'test-session') {
  const directory = await mkdtemp(join(run, 'case-'));
  const store = new FileStateStore(join(directory, 'sessions'), id);
  const sent = [];
  const logs = [];
  const warnings = [];
  const removed = [];
  const statuses = [];
  let config = validateConfig(overrides);
  let now = start;
  let info = { totalTokens: 1000, limit: 200000 };
  let active = false;
  let compactions = 0;
  let pending = [];
  const session = {
    sessionId: id,
    log: async (message, options) => warnings.push({ message, options }),
    send: async message => { sent.push(message); return `message-${sent.length}`; },
    rpc: {
      metadata: {
        snapshot: async () => ({ workingDirectory: directory, isRemote: false, clientName: 'copilot-cli' }),
        contextInfo: async () => ({ contextInfo: info }),
        getContextAttribution: async () => ({ contextAttribution: { compactions: { count: compactions } } }),
        activity: async () => ({ hasActiveWork: active }),
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
  await bridge.start();
  const f = {
    directory, store, session, sent, logs, warnings, removed, statuses,
    state: async () => JSON.parse(await readFile(store.path, 'utf8')),
    info: value => { info = value; },
    time: value => { now = value; },
    config: value => { config = validateConfig(value); },
    active: value => { active = value; },
    pending: value => { pending = value; },
    compactions: value => { compactions = value; },
    event: async (type, data = {}, extra = {}) => bridge.on({ type, data, id: `${type}-${now}`, ...extra }),
    idle: async (aborted = false) => bridge.on({ type: 'session.idle', data: { aborted } }),
    reload: async () => { bridge = create(); await bridge.start(); },
  };
  return f;
}

test('one attributed queued notice accompanies activity transitions without routine lifecycle chatter', async () => {
  const f = await fixture();
  f.info({ totalTokens: 51000, limit: 200000 });
  await f.idle();
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
  assert.equal((await f.state()).pressureOpportunityEpoch, 0);
  await f.event('user.message', { messageId: 'message-1' });
  f.info({ totalTokens: 132000, limit: 200000 });
  await f.idle();
  const hint = f.statuses.at(-1);
  assert.equal(hint.targets.length, 1);
  assert.equal(hint.targets[0].tokens, 182000);
  assert.equal(hint.targets[0].notBefore, start + 3600000);
  assert.equal((await f.state()).lastOpportunityTokens, 132000);
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
  { minimumMinutesBetweenOpportunities: Infinity }]) {
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

test('compaction records missed opportunity and does not replay a recovery checkpoint', async () => {
  const f = await fixture();
  await f.event('session.usage_info', { currentTokens: 70000, tokenLimit: 100000 });
  await f.event('session.compaction_start');
  await f.event('session.compaction_complete', { success: true });
  f.info({ totalTokens: 10000, limit: 100000 });
  await f.idle();
  assert.equal(f.sent.length, 0);
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

test('high post-compaction context cannot replay a pressure checkpoint without new activity', async () => {
  const f = await fixture();
  await f.event('session.compaction_start');
  await f.event('session.compaction_complete', { success: true });
  f.info({ totalTokens: 70000, limit: 100000 });
  await f.idle();
  f.time(start + 3600000);
  await f.idle();
  assert.equal(f.sent.length, 0);
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

test('reload observes compaction missed while detached and resets epoch', async () => {
  const f = await fixture();
  f.info({ totalTokens: 65000, limit: 100000 });
  await f.idle();
  await f.event('user.message', { messageId: 'message-1' });
  await f.idle();
  f.compactions(1);
  f.info({ totalTokens: 10000, limit: 100000 });
  await f.reload();
  assert.equal((await f.state()).compactionEpoch, 1);
  assert.equal((await f.state()).baselineTokens, 10000);
  await f.idle();
  assert.equal(f.sent.length, 1);
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
});

test('bounded diagnostics contain only allowed operational fields', async () => {
  const directory = await mkdtemp(join(run, 'logs-'));
  const logger = createLogger(directory, 'test-session', () => start);
  const record = { event: 'session.idle', gateDecision: 'below-gate', contextRatio: 0.2,
    prompt: 'synthetic-secret', cwd: 'private-path', toolResult: 'private-result' };
  await logger(record);
  await logger(record);
  const text = await readFile(join(directory, 'test-session.jsonl'), 'utf8');
  const rows = text.trim().split('\n');
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(rows[0])).sort(), ['contextRatio', 'event', 'gateDecision', 'sessionId', 'timestamp'].sort());
  assert.ok(!text.includes('private'));
  assert.ok(!text.includes('synthetic-secret'));
});

test('state filenames reject traversal and state contains no context/prompt text', async () => {
  for (const id of ['..', '..\\escape', 'bad/id', '']) assert.throws(() => new FileStateStore(run, id));
  const f = await fixture();
  await f.event('session.context_changed', { cwd: 'private-context', branch: 'private-branch' });
  const content = await readFile(f.store.path, 'utf8');
  assert.ok(!content.includes('private'));
  assert.equal((await readdir(join(f.directory, 'sessions'))).filter(name => name.endsWith('.json')).length, 1);
});
