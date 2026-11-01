import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { applyUsage, CaptureBridge, defaults, FileStateStore, freshState, statusContribution } from '../extension/bridge.mjs';
import { StatusPublisher } from '../extension/status-publisher.mjs';
import { contributionLabel, readContributions, validContribution } from '../statusline/contributions.mjs';
import { renderStatusLine, tokenBadge } from '../statusline/statusline.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(root, '.test-artifacts'), { recursive: true });
const run = await mkdtemp(join(root, '.test-artifacts', 'visibility-'));
const now = Date.parse('2026-10-10T00:00:00Z');
const usage = tokens => ({ currentTokens: tokens, tokenLimit: 1000000 });
const status = tokens => ({ session_id: 'test-session', context_window: {
  current_context_tokens: tokens, displayed_context_limit: 1000000,
} });
const activity = label => ({ kind: 'activity', label, color: 'yellow', priority: 100 });
const checkpointActivity = label => ({ ...activity(label), prefix: 'last checkpoint: 198K, next checkpoint: ' });
const white = value => `\u001b[37m${value}\u001b[39m`;
const yellow = value => `\u001b[33m${value}\u001b[39m`;
const red = value => `\u001b[31m${value}\u001b[39m`;

function stateAt(baseline = 455000, tokens = 500000) {
  const state = freshState('test-session');
  state.lastIntegrationEpoch = state.compactionEpoch;
  applyUsage(state, usage(baseline), defaults);
  applyUsage(state, usage(tokens), defaults);
  return state;
}

test('idle hint uses earliest token target and white independent foreground', () => {
  const state = stateAt();
  const hint = statusContribution(state, usage(500000), defaults);
  assert.equal(Math.min(...hint.targets.map(value => value.tokens)), 505000);
  assert.equal(tokenBadge(status(500000), [hint], now),
    `tokens: 500K (${white('50%')}) ${white('last checkpoint: none, next checkpoint: 505K')}`);
});

test('the upcoming fifth checkpoint shows the requested integration suffix in yellow only', () => {
  const state = stateAt(411000, 567000);
  state.completedCheckpoints = 4;
  state.lastCheckpointTokens = 411000;
  const currentUsage = { currentTokens: 567000, tokenLimit: 922000, compactionThreshold: 737600 };
  const hint = statusContribution(state, currentUsage, { ...defaults, periodicMinimumNewTokens: 169000 });
  const native = { session_id: 'test-session', context_window: {
    current_context_tokens: 567000, displayed_context_limit: 922000,
  } };
  assert.equal(tokenBadge(native, [hint], now),
    `tokens: 567K (${yellow('61% \u2014 nearing compaction')}) ${white('last checkpoint: 411K, next checkpoint: 580K')}${white(' (')}${yellow('integration')}${white(')')}`);
  state.captureInFlight = { id: 'fifth', kind: 'periodic', epoch: 0, integration: true,
    messageId: 'accepted', started: false };
  assert.equal(tokenBadge(native, [statusContribution(state, currentUsage, defaults)], now),
    `tokens: 567K (${yellow('61% \u2014 nearing compaction')}) ${white('last checkpoint: 411K, next checkpoint: ')}${yellow('queued')}${white(' (')}${yellow('integration')}${white(')')}`);
});

test('forecast selects the integration annotation only when its pressure target is the next action', () => {
  const state = stateAt(500000, 600000);
  state.lastIntegrationEpoch = null;
  state.lastOpportunityTokens = 600000;
  const hint = statusContribution(state, usage(600000), { ...defaults, periodicMinimumNewTokens: 200000 });
  assert.equal(contributionLabel(hint, 600000, now).annotation, undefined);
  state.pressureOpportunityEpoch = state.compactionEpoch;
  const integration = statusContribution(state, usage(600000), { ...defaults, periodicMinimumNewTokens: 200000 });
  assert.equal(contributionLabel(integration, 600000, now).text, 'last checkpoint: none, next checkpoint: 700K');
  assert.deepEqual(contributionLabel(integration, 600000, now).annotation, { text: 'integration', color: 'yellow' });
  assert.equal(contributionLabel(integration, 700000, now).text, 'last checkpoint: none, next checkpoint: awaiting idle');
});

test('generic annotations reject invalid colors and control characters without altering ordinary contributions', () => {
  for (const annotation of [{ text: 'integration', color: 'orange' }, { text: '\u001b[31m', color: 'yellow' },
    { text: '', color: 'yellow' }, { text: 'x'.repeat(41), color: 'yellow' }]) {
    assert.equal(validContribution({ ...activity('Working'), annotation }), false);
  }
  const annotated = { ...activity('Working'), annotation: { text: 'integration', color: 'yellow' } };
  assert.equal(tokenBadge({}, [annotated]), `${yellow('Working')}${white(' (')}${yellow('integration')}${white(')')}`);
});
test('recovery status preserves historical checkpoint text without claiming another checkpoint', () => {
  const state = stateAt();
  state.lastCheckpointTokens = 198000;
  state.pendingRecoveryEpoch = state.compactionEpoch;
  const pending = statusContribution(state, usage(500000), defaults);
  assert.equal(tokenBadge(status(500000), [pending], now),
    `tokens: 500K (${white('50%')}) ${white('last checkpoint: 198K, state recovery: awaiting idle')}`);
  state.pendingRecoveryEpoch = null;
  state.captureInFlight = { id: 'recovery', epoch: 0, kind: 'recovery', startTokens: 500000,
    messageId: 'message', started: false };
  assert.equal(tokenBadge(status(500000), [statusContribution(state, usage(500000), defaults)], now),
    `tokens: 500K (${white('50%')}) ${white('last checkpoint: 198K, state recovery: ')}${yellow('queued')}`);
  state.captureInFlight.started = true;
  assert.equal(statusContribution(state, usage(500000), defaults).label, 'in progress');
  assert.equal(state.lastCheckpointTokens, 198000);
});
test('pressure target wins when periodic threshold is farther away', () => {
  const state = stateAt(630000, 630000);
  const hint = statusContribution(state, usage(630000), defaults);
  assert.equal(Math.min(...hint.targets.map(value => value.tokens)), 650000);
  assert.equal(contributionLabel(hint, 630000, now).text, 'last checkpoint: none, next checkpoint: 650K');
});

test('published integration annotations survive the generic reader without extra payload fields', async () => {
  const target = await mkdtemp(join(run, 'annotation-'));
  const publisher = new StatusPublisher(target, 'annotation-session', 'provider', { clock: () => now });
  try {
    await publisher.publish({
      kind: 'hint', priority: 10, color: 'white',
      annotation: { text: 'integration', color: 'yellow', extra: 'must not persist' },
      targets: [{ tokens: 580000, notBefore: 0, annotation: { text: 'integration', color: 'yellow', extra: 'must not persist' } }],
      labels: { tokens: 'next checkpoint: {tokens}', time: 'in {minutes}m', ready: 'awaiting idle' },
    });
    const record = JSON.parse(await readFile(publisher.path, 'utf8'));
    assert.ok(!JSON.stringify(record).includes('must not persist'));
    const [contribution] = await readContributions(target, 'annotation-session', { now });
    assert.deepEqual(contributionLabel(contribution, 567000, now).annotation, { text: 'integration', color: 'yellow' });
    assert.equal(contributionLabel(contribution, 567000, now).text, 'next checkpoint: 580K');
  } finally {
    await publisher.close();
  }
});
test('reached target shows live cooldown countdown, then awaits idle without claiming acceptance', () => {
  const state = stateAt();
  state.lastOpportunityAt = now - 48 * 60000;
  state.lastOpportunityTokens = 455000;
  state.lastCheckpointTokens = 455000;
  const hint = statusContribution(state, usage(505000), defaults);
  assert.equal(contributionLabel(hint, 504999, now).text, 'last checkpoint: 455K, next checkpoint: 505K');
  assert.equal(contributionLabel(hint, 505000, now).text, 'last checkpoint: 455K, next checkpoint: in 12m');
  assert.equal(contributionLabel(hint, 505000, now + 60000).text, 'last checkpoint: 455K, next checkpoint: in 11m');
  assert.equal(contributionLabel(hint, 505000, now + 12 * 60000 - 1).text, 'last checkpoint: 455K, next checkpoint: in 1m');
  assert.equal(contributionLabel(hint, 505000, now + 12 * 60000).text, 'last checkpoint: 455K, next checkpoint: awaiting idle');
  assert.equal(contributionLabel(hint, 700000, now + 12 * 60000).text, 'last checkpoint: 455K, next checkpoint: awaiting idle');
});

test('both token triggers reached chooses the earlier cooldown', () => {
  const state = stateAt(500000, 700000);
  state.lastOpportunityAt = now;
  state.lastOpportunityTokens = 500000;
  state.lastCheckpointTokens = 500000;
  const hint = statusContribution(state, usage(700000), defaults);
  assert.equal(contributionLabel(hint, 700000, now).text, 'last checkpoint: 500K, next checkpoint: in 5m');
  assert.equal(contributionLabel(hint, 700000, now + 5 * 60000).text, 'last checkpoint: 500K, next checkpoint: awaiting idle');
  state.pressureOpportunityEpoch = state.compactionEpoch;
  const consumed = statusContribution(state, usage(700000), defaults);
  assert.equal(consumed.targets.length, 1);
  assert.equal(contributionLabel(consumed, 700000, now).text, 'last checkpoint: 500K, next checkpoint: in 60m');
});

test('active checkpoint suffix alone is yellow while compaction warnings stay inside the percentage parentheses', () => {
  const queued = checkpointActivity('queued');
  const progress = checkpointActivity('in progress');
  const prefix = white('last checkpoint: 198K, next checkpoint: ');
  assert.equal(tokenBadge(status(550000), [progress], now),
    `tokens: 550K (${white('55%')}) ${prefix}${yellow('in progress')}`);
  assert.equal(tokenBadge(status(650000), [queued], now),
    `tokens: 650K (${yellow('65% \u2014 nearing compaction')}) ${prefix}${yellow('queued')}`);
  assert.equal(tokenBadge(status(710000), [progress], now),
    `tokens: 710K (${red('71% \u2014 compaction imminent')}) ${prefix}${yellow('in progress')}`);
  assert.equal(tokenBadge(status(710000), [], now),
    `tokens: 710K (${red('71% \u2014 compaction imminent')})`);
});

test('checkpoint hints remain visible above 60 percent and active status only replaces the forecast', () => {
  const hint = statusContribution(stateAt(), usage(500000), defaults);
  assert.equal(tokenBadge(status(650000), [hint], now),
    `tokens: 650K (${yellow('65% \u2014 nearing compaction')}) ${white('last checkpoint: none, next checkpoint: awaiting idle')}`);
  assert.equal(tokenBadge(status(790000), [hint], now),
    `tokens: 790K (${red('79% \u2014 compaction imminent')}) ${white('last checkpoint: none, next checkpoint: awaiting idle')}`);
  assert.equal(tokenBadge(status(500000), [checkpointActivity('queued'), hint], now),
    `tokens: 500K (${white('50%')}) ${white('last checkpoint: 198K, next checkpoint: ')}${yellow('queued')}`);
  assert.equal(tokenBadge(status(500000), [hint], now),
    `tokens: 500K (${white('50%')}) ${white('last checkpoint: none, next checkpoint: 505K')}`);
});

test('generic activity names need no provider-specific renderer logic', () => {
  const contribution = activity('Index rebuilding');
  assert.equal(renderStatusLine(JSON.stringify(status(100000)),
    { previousStatusLine: { command: 'synthetic' }, showTokens: true },
    { contributions: [contribution], now, run: () => ({ status: 0, stdout: '[existing]' }) }),
  `[existing] | tokens: 100K (${white('10%')}) ${yellow('Index rebuilding')}`);
  assert.equal(tokenBadge({}, [contribution], now), yellow('Index rebuilding'));
});

test('disabled, unavailable, compaction and unaccepted reservations have no hint/status', () => {
  const state = stateAt();
  assert.equal(statusContribution(state, usage(500000), { ...defaults, enabled: false }), null);
  assert.equal(statusContribution(state, null, defaults), null);
  state.compacting = true;
  assert.equal(statusContribution(state, usage(500000), defaults), null);
  state.compacting = false;
  state.captureInFlight = { messageId: null, started: false };
  assert.equal(statusContribution(state, usage(500000), defaults), null);
  state.captureInFlight.messageId = 'own-message';
  assert.equal(statusContribution(state, usage(500000), defaults).label, 'queued');
  assert.equal(statusContribution(state, usage(500000), defaults).prefix, 'last checkpoint: none, next checkpoint: ');
  state.captureInFlight.started = true;
  assert.equal(statusContribution(state, usage(500000), defaults).label, 'in progress');
});

test('context shrink and post-compaction pressure baseline remain conservative', () => {
  const state = stateAt(700000, 700000);
  const hint = statusContribution(state, usage(100000), defaults);
  assert.equal(Math.min(...hint.targets.map(value => value.tokens)), 150000);
  state.compactionEpoch = 1;
  state.baselineTokens = 700000;
  state.lastOpportunityTokens = null;
  state.lastContextTokens = 700000;
  const post = statusContribution(state, usage(700000), defaults);
  assert.equal(Math.min(...post.targets.map(value => value.tokens)), 700001);
  assert.equal(contributionLabel(post, 700000, now).text, 'last checkpoint: none, next checkpoint: 701K');
});

test('generic schedule avoids rounding a token target down prematurely', () => {
  const hint = statusContribution(stateAt(455001), usage(500000), defaults);
  assert.equal(contributionLabel(hint, 505000, now).text, 'last checkpoint: none, next checkpoint: 506K');
});

test('requested last/next layout rounds the historical count and rounds the future target up', () => {
  const state = stateAt(123456, 123456);
  state.lastOpportunityAt = now;
  state.lastOpportunityTokens = 123456;
  state.lastCheckpointTokens = 123456;
  const hint = statusContribution(state, usage(123456), defaults);
  const native = { ...status(123456), context_window: {
    current_context_tokens: 123456, displayed_context_limit: 922000,
  } };
  assert.equal(tokenBadge(native, [hint], now),
    `tokens: 123K (${white('13%')}) ${white('last checkpoint: 123K, next checkpoint: 174K')}`);
});

test('unknown imported checkpoint position is not fabricated from the initial baseline', () => {
  const state = stateAt();
  state.lastOpportunityAt = now;
  state.lastCheckpointAt = now;
  const hint = statusContribution(state, usage(500000), defaults);
  assert.equal(contributionLabel(hint, 500000, now).text, 'last checkpoint: unknown, next checkpoint: 505K');
});

test('requested separated layout retains white checkpoint information at 79 percent', () => {
  const state = stateAt(199000, 216000);
  state.lastOpportunityAt = now;
  state.lastOpportunityTokens = 199000;
  state.lastCheckpointTokens = 198000;
  state.lastCheckpointAt = now;
  state.pressureOpportunityEpoch = state.compactionEpoch;
  const nativeUsage = { currentTokens: 216000, tokenLimit: 272000, compactionThreshold: 260000 };
  const hint = statusContribution(state, nativeUsage, defaults);
  const native = { session_id: 'test-session', context_window: {
    current_context_tokens: 216000, displayed_context_limit: 272000,
  } };
  assert.equal(tokenBadge(native, [hint], now),
    `tokens: 216K (${red('79% \u2014 compaction imminent')}) ${white('last checkpoint: 198K, next checkpoint: 249K')}`);
  nativeUsage.compactionThreshold = 200000;
  const blocked = statusContribution(state, nativeUsage, defaults);
  assert.equal(tokenBadge(native, [blocked], now),
    `tokens: 216K (${red('79% \u2014 compaction imminent')}) ${white('last checkpoint: 198K, next checkpoint: compaction expected first')}`);
});

test('future target at the native compaction boundary is not advertised as a pre-compaction checkpoint', () => {
  const state = stateAt();
  state.pressureOpportunityEpoch = state.compactionEpoch;
  const hint = statusContribution(state, { ...usage(500000), compactionThreshold: 505000 }, defaults);
  assert.equal(contributionLabel(hint, 500000, now).text, 'last checkpoint: none, next checkpoint: compaction expected first');
  assert.equal(contributionLabel(hint, 505000, now).text, 'last checkpoint: none, next checkpoint: awaiting idle');
});

test('crossing the native boundary takes precedence over a future cooldown but not an already-eligible opportunity', () => {
  const state = stateAt();
  state.pressureOpportunityEpoch = state.compactionEpoch;
  state.lastOpportunityAt = now;
  state.lastCheckpointTokens = 455000;
  state.lastCheckpointAt = now;
  const hint = statusContribution(state, { ...usage(505000), compactionThreshold: 500000 }, defaults);
  assert.equal(contributionLabel(hint, 505000, now).text, 'last checkpoint: 455K, next checkpoint: compaction expected first');
  assert.equal(contributionLabel(hint, 505000, now + 60 * 60000).text, 'last checkpoint: 455K, next checkpoint: awaiting idle');
});

test('the reported overdue first-checkpoint target displays awaiting idle in white, not queued', () => {
  const state = stateAt(35506, 551000);
  const nativeUsage = { currentTokens: 551000, tokenLimit: 922000, compactionThreshold: 737600 };
  const hint = statusContribution(state, nativeUsage, defaults);
  const native = { session_id: 'test-session', context_window: {
    current_context_tokens: 551000, displayed_context_limit: 922000,
  } };
  assert.equal(hint.targets[0].tokens, 85506);
  assert.equal(tokenBadge(native, [hint], now),
    `tokens: 551K (${yellow('60% \u2014 nearing compaction')}) ${white('last checkpoint: none, next checkpoint: awaiting idle')}`);
  assert.equal(state.lastOpportunityAt, null);
  assert.equal(state.captureInFlight, null);
});

test('an overdue target after resume retains the historical checkpoint and does not change cadence', () => {
  const state = stateAt(354228, 497518);
  state.lastOpportunityAt = now - 7200000;
  state.lastCheckpointAt = now - 7180000;
  state.lastCheckpointTokens = 281313;
  state.lastOpportunityTokens = 354228;
  const before = structuredClone(state);
  const nativeUsage = { currentTokens: 497518, tokenLimit: 922000, compactionThreshold: 737600 };
  const hint = statusContribution(state, nativeUsage, defaults);
  assert.equal(hint.targets[0].tokens, 404228);
  assert.equal(contributionLabel(hint, 497518, now).text,
    'last checkpoint: 281K, next checkpoint: awaiting idle');
  assert.deepEqual(state, before);
});

test('native context limit bounds forecasts when the optional compaction threshold is unavailable', () => {
  const state = stateAt(950000, 960000);
  state.pressureOpportunityEpoch = state.compactionEpoch;
  const hint = statusContribution(state, usage(960000), defaults);
  assert.equal(hint.tokenCeiling, 1000000);
  assert.equal(contributionLabel(hint, 960000, now).text, 'last checkpoint: none, next checkpoint: compaction expected first');
});

test('protocol rejects invalid/control-bearing contributions', () => {
  for (const bad of [null, { ...activity('valid'), color: 'purple' },
    activity('escape\u001b[31m'), { ...activity('valid'), prefix: 'escape\u001b[31m' },
    { ...activity('valid'), priority: 101 },
    { kind: 'hint', color: 'white', priority: 10, targets: [{ tokens: -1, notBefore: now }], labels: {} }]) {
    assert.equal(validContribution(bad), false);
    assert.equal(contributionLabel(bad, 500000, now), null);
  }
});

test('atomic publication renews freshness, clears without deleting, and isolates sessions', async () => {
  const directory = await mkdtemp(join(run, 'protocol-'));
  let clock = now;
  const publisher = new StatusPublisher(directory, 'test-session', 'provider-a', { clock: () => clock });
  try {
    await publisher.publish(activity('Working'));
    assert.equal((await readContributions(directory, 'test-session', { now: clock })).length, 1);
    assert.equal((await readContributions(directory, 'another-session', { now: clock })).length, 0);
    clock += 30000;
    assert.equal((await readContributions(directory, 'test-session', { now: clock })).length, 0);
    await publisher.renew();
    assert.equal((await readContributions(directory, 'test-session', { now: clock })).length, 1);
    await publisher.publish(null);
    assert.equal((await readContributions(directory, 'test-session', { now: clock })).length, 0);
    assert.equal((await readdir(join(directory, 'test-session'))).length, 1);
  } finally {
    await publisher.close();
  }
});

test('older publisher cannot overwrite or clear a new process owner', async () => {
  const directory = await mkdtemp(join(run, 'owners-'));
  const first = new StatusPublisher(directory, 'test-session', 'provider', { clock: () => now });
  const second = new StatusPublisher(directory, 'test-session', 'provider', { clock: () => now });
  try {
    await first.publish(activity('Old'));
    await second.publish(activity('New'));
    await first.renew();
    await first.close();
    assert.equal((await readContributions(directory, 'test-session', { now }))[0].label, 'New');
  } finally {
    await first.close();
    await second.close();
  }
});

test('heartbeat queued behind a new status cannot resurrect the old label', async () => {
  const directory = await mkdtemp(join(run, 'renewal-race-'));
  const publisher = new StatusPublisher(directory, 'test-session', 'provider', { clock: () => now });
  try {
    await publisher.publish(activity('Queued'));
    await Promise.all([publisher.publish(activity('In progress')), publisher.renew()]);
    assert.equal((await readContributions(directory, 'test-session', { now }))[0].label, 'In progress');
  } finally {
    await publisher.close();
  }
});

test('publication includes only generic fields and drops extraneous payload contents', async () => {
  const directory = await mkdtemp(join(run, 'payload-filter-'));
  const publisher = new StatusPublisher(directory, 'test-session', 'provider', { clock: () => now });
  try {
    await publisher.publish({ ...activity('Working'), prompt: 'SYNTHETIC-NOT-FOR-STATUS', toolResult: 'private-extra' });
    const content = await readFile(publisher.path, 'utf8');
    assert.ok(!content.includes('SYNTHETIC-NOT-FOR-STATUS'));
    assert.ok(!content.includes('private-extra'));
    assert.deepEqual(Object.keys(JSON.parse(content).contribution).sort(), ['color', 'kind', 'label', 'priority']);
  } finally {
    await publisher.close();
  }
});

test('publication preserves neutral activity prefix and generic forecast boundary', async () => {
  const directory = await mkdtemp(join(run, 'extended-protocol-'));
  const publisher = new StatusPublisher(directory, 'test-session', 'provider', { clock: () => now });
  try {
    await publisher.publish(checkpointActivity('queued'));
    let records = await readContributions(directory, 'test-session', { now });
    assert.equal(records[0].prefix, 'last checkpoint: 198K, next checkpoint: ');
    assert.equal(contributionLabel(records[0], null, now).text, 'queued');
    const state = stateAt();
    state.pressureOpportunityEpoch = state.compactionEpoch;
    await publisher.publish(statusContribution(state, { ...usage(500000), compactionThreshold: 505000 }, defaults));
    records = await readContributions(directory, 'test-session', { now });
    assert.equal(records[0].tokenCeiling, 505000);
    assert.equal(contributionLabel(records[0], 500000, now).text, 'last checkpoint: none, next checkpoint: compaction expected first');
    assert.equal(validContribution({ ...records[0], tokenCeiling: 0 }), false);
    assert.equal(validContribution({ ...records[0], labels: { ...records[0].labels, beyond: '\u001b[31m' } }), false);
  } finally {
    await publisher.close();
  }
});

test('reader handles malformed, cross-session and unbounded-expiry records without leaking data', async () => {
  const directory = await mkdtemp(join(run, 'bad-records-'));
  await mkdir(join(directory, 'test-session'));
  for (const [filename, body] of [
    ['bad.json', '{private-content'],
    ['cross.json', JSON.stringify({ version: 1, sessionId: 'other', expiresAt: now + 1000, contribution: activity('private-label') })],
    ['forever.json', JSON.stringify({ version: 1, sessionId: 'test-session', expiresAt: now + 86400000, contribution: activity('private-label') })],
  ]) await writeFile(join(directory, 'test-session', filename), body);
  const warnings = [];
  assert.deepEqual(await readContributions(directory, 'test-session', { now, warn: value => warnings.push(value) }), []);
  assert.equal(warnings.length, 3);
  assert.ok(!JSON.stringify(warnings).includes('private'));
  assert.deepEqual(await readContributions(directory, '..\\escape', { now }), []);
});

test('generic activity priority is deterministic and hints are independent', async () => {
  const directory = await mkdtemp(join(run, 'priorities-'));
  const a = new StatusPublisher(directory, 'test-session', 'a', { clock: () => now });
  const b = new StatusPublisher(directory, 'test-session', 'b', { clock: () => now });
  try {
    await a.publish({ ...activity('Low priority'), priority: 20 });
    await b.publish(activity('High priority'));
    const contributions = await readContributions(directory, 'test-session', { now });
    assert.equal(contributions[0].label, 'High priority');
    assert.ok(tokenBadge(status(100000), contributions, now).endsWith(yellow('High priority')));
    const record = JSON.parse(await readFile(b.path, 'utf8'));
    assert.deepEqual(Object.keys(record).sort(), ['contribution', 'expiresAt', 'owner', 'sessionId', 'version']);
  } finally {
    await a.close();
    await b.close();
  }
});

test('real producer files drive exact configured-command output through the full checkpoint lifecycle', async () => {
  const directory = await mkdtemp(join(run, 'end-to-end-'));
  const providerRoot = join(directory, 'statusline', 'contributions');
  const publisher = new StatusPublisher(providerRoot, 'test-session', 'provider');
  const store = new FileStateStore(join(directory, 'sessions'), 'test-session');
  const notices = [];
  let tokens = 455000;
  const clock = Date.now();
  const limit = 909091;
  const session = {
    sessionId: 'test-session', log: async message => notices.push(message),
    send: async () => 'own-request',
    rpc: {
      metadata: {
        snapshot: async () => ({ workingDirectory: directory, clientName: 'copilot-cli', isRemote: false }),
        contextInfo: async () => ({ contextInfo: { totalTokens: tokens, limit } }),
        getContextAttribution: async () => ({ contextAttribution: { compactions: { count: 0 } } }),
        activity: async () => ({ hasActiveWork: false }),
      },
      queue: { pendingItems: async () => ({ items: [], steeringMessages: [] }) },
    },
  };
  const bridge = new CaptureBridge({
    session, store, config: async () => defaults, log: async () => {},
    status: value => publisher.publish(value), clock: () => clock,
  });
  const previous = join(directory, 'previous.mjs');
  await writeFile(previous, "process.stdout.write('[existing]');\n");
  const renderer = join(directory, 'statusline.mjs');
  await copyFile(join(root, 'statusline', 'statusline.mjs'), renderer);
  await copyFile(join(root, 'statusline', 'contributions.mjs'), join(directory, 'contributions.mjs'));
  await writeFile(join(directory, 'config.json'), JSON.stringify({
    previousStatusLine: { command: `"${process.execPath}" "${previous}"` }, showTokens: true,
  }));
  const render = () => {
    const result = spawnSync(process.execPath, [renderer], {
      encoding: 'utf8', timeout: 5000, env: { ...process.env, COPILOT_HOME: directory },
      input: JSON.stringify({ session_id: 'test-session', cwd: directory, context_window: {
        current_context_tokens: tokens, displayed_context_limit: limit,
      } }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return result.stdout;
  };
  try {
    await bridge.start();
    tokens = 500000;
    await store.transaction(state => {
      state.lastOpportunityAt = clock - 48 * 60000;
      state.lastOpportunityTokens = 455000;
      state.lastCheckpointTokens = 455000;
      state.lastCheckpointAt = clock - 48 * 60000;
    });
    await bridge.on({ type: 'session.idle', data: {} });
    assert.equal(render(), `[existing] | tokens: 500K (${white('55%')}) ${white('last checkpoint: 455K, next checkpoint: 505K')}`);
    tokens = 505000;
    await bridge.on({ type: 'session.idle', data: {} });
    assert.equal(render(), `[existing] | tokens: 505K (${white('56%')}) ${white('last checkpoint: 455K, next checkpoint: in 12m')}`);
    await store.transaction(state => { state.lastOpportunityAt = clock - 60 * 60000; });
    await bridge.on({ type: 'user.message', data: { messageId: 'synthetic-user', source: 'user', delivery: 'steering' } });
    assert.equal(render(), `[existing] | tokens: 505K (${white('56%')}) ${white('last checkpoint: 455K, next checkpoint: awaiting idle')}`);
    assert.deepEqual(notices, []);
    await bridge.on({ type: 'session.idle', data: {} });
    assert.equal(render(), `[existing] | tokens: 505K (${white('56%')}) ${white('last checkpoint: 455K, next checkpoint: ')}${yellow('queued')}`);
    await bridge.on({ type: 'user.message', data: { messageId: 'own-request', source: 'system', delivery: 'idle' } });
    assert.equal(render(), `[existing] | tokens: 505K (${white('56%')}) ${white('last checkpoint: 455K, next checkpoint: ')}${yellow('in progress')}`);
    await bridge.on({ type: 'session.idle', data: { aborted: true } });
    assert.equal(render(), `[existing] | tokens: 505K (${white('56%')}) ${white('last checkpoint: 505K, next checkpoint: 555K')}`);
    assert.deepEqual(notices, ['[basic-memory-bridge] Memory checkpoint queued']);
  } finally {
    await publisher.close();
  }
});
