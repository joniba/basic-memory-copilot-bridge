import assert from 'node:assert/strict';
import * as files from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { bridgeCommand, parseCommand, writeInterval } from '../extension/commands.mjs';
import { CaptureBridge, defaults, eligibility, FileStateStore, freshState, validateConfig } from '../extension/bridge.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
await files.mkdir(join(root, '.test-artifacts'), { recursive: true });
const run = await files.mkdtemp(join(root, '.test-artifacts', 'commands-'));
const now = Date.parse('2026-10-15T10:00:00Z');

async function fixture(config = defaults, stateChanges = {}, sharedPath) {
  const directory = await files.mkdtemp(join(run, 'case-'));
  const path = sharedPath ?? join(directory, 'config.json');
  if (!sharedPath) await files.writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  const id = sharedPath ? 'peer-session' : 'command-session';
  const state = Object.assign(freshState(id), {
    baselineTokens: 1000, lastOpportunityTokens: 1000, lastContextTokens: 61000,
    tokenLimit: 1000000, lastOpportunityAt: now - 7200000,
    lastCheckpointTokens: 2000, lastCheckpointAt: now - 7100000,
  }, stateChanges);
  const store = new FileStateStore(directory, id);
  await files.writeFile(store.path, JSON.stringify(state));
  const logs = [];
  const statuses = [];
  const dialogs = [];
  let selected = null;
  let entered = null;
  const session = {
    sessionId: id,
    capabilities: { ui: { elicitation: true } },
    ui: {
      select: async (message, choices) => { dialogs.push({ kind: 'select', message, choices }); return selected; },
      input: async (message, options) => { dialogs.push({ kind: 'input', message, options }); return entered; },
    },
    log: async (message, options) => logs.push({ message, options }),
    send: async () => { assert.fail('A slash command must not start a model turn.'); },
  };
  const bridge = new CaptureBridge({
    session, store, config: async () => validateConfig(JSON.parse(await files.readFile(path, 'utf8'))),
    log: async () => {}, status: async value => statuses.push(value), clock: () => now,
  });
  bridge.lastState = structuredClone(state);
  bridge.usage = { currentTokens: state.lastContextTokens, tokenLimit: state.tokenLimit };
  bridge.ready = true;
  const command = bridgeCommand(path, () => bridge);
  return {
    path, directory, store, state, bridge, session, command, logs, statuses, dialogs,
    select: value => { selected = value; },
    input: value => { entered = value; },
    invoke: args => command.handler({ sessionId: id, commandName: 'bm-bridge', command: `/bm-bridge ${args}`, args }),
  };
}

test('native command parses positive integer thousands and supports inspection/help', () => {
  assert.equal(parseCommand('interval 100'), 100000);
  assert.equal(parseCommand(' interval 50 '), 50000);
  assert.equal(parseCommand('interval 9007199254740'), 9007199254740000);
  for (const args of ['', 'help', '--help', '-h', 'interval']) assert.equal(parseCommand(args), null);
  for (const args of ['interval 0', 'interval -1', 'interval 1.5', 'interval 100K',
    'interval 1e2', 'interval Infinity', 'interval 9007199254741', 'interval 100 extra',
    'disable', 'help extra', null]) {
    assert.throws(() => parseCommand(args), /Usage:/);
  }
});

test('atomic machine interval update preserves all other values and newline style', async () => {
  const config = { ...defaults, minimumMinutesBetweenOpportunities: 123,
    contextPressureThreshold: 0.8, pressureMinimumMinutesBetweenOpportunities: 7, debugLogging: false };
  const f = await fixture(config);
  await files.writeFile(f.path, `${JSON.stringify(config, null, 2).replaceAll('\n', '\r\n')}\r\n`);
  const result = await writeInterval(f.path, 100000);
  assert.equal(result.changed, true);
  assert.deepEqual(JSON.parse(await files.readFile(f.path, 'utf8')), { ...config, periodicMinimumNewTokens: 100000 });
  assert.ok((await files.readFile(f.path, 'utf8')).includes('\r\n'));
  await assert.rejects(files.lstat(`${f.path}.lock`), { code: 'ENOENT' });
  assert.deepEqual((await files.readdir(f.directory)).sort(), ['command-session.json', 'config.json']);
});

test('same-value update is byte-preserving and direct invalid values never create a lock', async () => {
  const f = await fixture();
  const before = await files.readFile(f.path);
  assert.equal((await writeInterval(f.path, 50000)).changed, false);
  for (const value of [0, -1000, 1001, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(writeInterval(f.path, value), /Usage:/);
  }
  assert.deepEqual(await files.readFile(f.path), before);
  await assert.rejects(files.lstat(`${f.path}.lock`), { code: 'ENOENT' });
});

test('an explicitly selected inherited default is persisted without materializing other defaults', async () => {
  const f = await fixture({ enabled: true });
  assert.equal((await writeInterval(f.path, 50000)).changed, true);
  assert.deepEqual(JSON.parse(await files.readFile(f.path)), { enabled: true, periodicMinimumNewTokens: 50000 });
});

test('foreign config lock is neither stolen nor removed and failure is explicit', async () => {
  const f = await fixture();
  const before = await files.readFile(f.path);
  await files.writeFile(`${f.path}.lock`, 'foreign-owner');
  await f.invoke('interval 100');
  assert.deepEqual(await files.readFile(f.path), before);
  assert.equal(await files.readFile(`${f.path}.lock`, 'utf8'), 'foreign-owner');
  assert.equal(f.logs.at(-1).options.level, 'warning');
  assert.match(f.logs.at(-1).message, /locked by another writer/);
  assert.equal(f.statuses.length, 0);
});

test('invalid or missing installed configuration is not replaced with defaults', async () => {
  const f = await fixture();
  await files.writeFile(f.path, '{"enabled":"invalid"}');
  await f.invoke('interval 100');
  assert.equal(await files.readFile(f.path, 'utf8'), '{"enabled":"invalid"}');
  assert.match(f.logs.at(-1).message, /configuration is invalid/);
  const missing = join(f.directory, 'missing.json');
  await assert.rejects(writeInterval(missing, 100000), error => error.stage === 'read' && error.code === 'ENOENT');
  await assert.rejects(files.lstat(missing), { code: 'ENOENT' });
});

test('failed atomic replacement leaves original config and staged evidence, with no raw error leakage', async () => {
  const f = await fixture();
  const before = await files.readFile(f.path);
  await assert.rejects(writeInterval(f.path, 100000, {
    ...files, rename: async () => { throw Object.assign(new Error('private-error-and-path'), { code: 'EACCES' }); },
  }), error => error.stage === 'replace' && error.code === 'EACCES'
    && error.committed === false && !error.message.includes('private'));
  assert.deepEqual(await files.readFile(f.path), before);
  const staged = (await files.readdir(f.directory)).filter(name => name.endsWith('.tmp'));
  assert.equal(staged.length, 1);
  assert.equal(JSON.parse(await files.readFile(join(f.directory, staged[0]))).periodicMinimumNewTokens, 100000);
  await assert.rejects(files.lstat(`${f.path}.lock`), { code: 'ENOENT' });
});

test('concurrent manual configuration edit is preserved rather than overwritten', async () => {
  const f = await fixture();
  const competing = JSON.stringify({ ...defaults, minimumMinutesBetweenOpportunities: 99 });
  await assert.rejects(writeInterval(f.path, 100000, {
    ...files, writeFile: async (...args) => {
      await files.writeFile(...args);
      await files.writeFile(f.path, competing);
    },
  }), error => error.stage === 'concurrent-change' && error.committed === false);
  assert.equal(await files.readFile(f.path, 'utf8'), competing);
});

test('changed config-lock ownership is retained, and a committed update is not reported as unapplied', async () => {
  const f = await fixture();
  await assert.rejects(writeInterval(f.path, 100000, {
    ...files, rename: async (...args) => {
      await files.rename(...args);
      await files.writeFile(`${f.path}.lock`, 'new-owner');
    },
  }), error => error.stage === 'lock-release' && error.committed === true);
  assert.equal(JSON.parse(await files.readFile(f.path)).periodicMinimumNewTokens, 100000);
  assert.equal(await files.readFile(`${f.path}.lock`, 'utf8'), 'new-owner');
});

test('native interval command changes actual 50K eligibility to 100K and refreshes forecast without history writes', async () => {
  const f = await fixture();
  const before = await files.readFile(f.store.path);
  assert.equal(eligibility(f.state, await f.bridge.readConfig(), now), 'periodic');
  assert.equal(f.command.name, 'bm-bridge');
  await f.invoke('interval 100');
  assert.equal(eligibility(f.state, await f.bridge.readConfig(), now), 'below-gate');
  assert.equal(f.statuses.at(-1).targets[0].tokens, 101000);
  assert.equal(f.statuses.at(-1).targets[0].notBefore, f.state.lastOpportunityAt + 3600000);
  assert.equal(f.statuses.at(-1).targets[1].tokens, 650000);
  assert.deepEqual(await files.readFile(f.store.path), before);
  assert.deepEqual(f.bridge.lastState, f.state);
  assert.match(f.logs.at(-1).message, /Machine-wide periodic interval set to 100K/);
  assert.equal(f.logs.at(-1).options.level, 'info');
});

test('other sessions sharing the same config adopt the new interval on their next native event', async () => {
  const f = await fixture();
  const peer = await fixture(defaults, {}, f.path);
  const peerState = await files.readFile(peer.store.path);
  await f.invoke('interval 100');
  assert.equal((await peer.bridge.readConfig()).periodicMinimumNewTokens, 100000);
  await peer.bridge.on({ type: 'session.usage_info', data: { currentTokens: 61000, tokenLimit: 1000000 } });
  assert.equal(peer.statuses.at(-1).targets[0].tokens, 101000);
  assert.deepEqual(await files.readFile(peer.store.path), peerState);
});

test('accepted checkpoint and pressure eligibility are unaffected by interval change', async () => {
  const flight = { id: 'accepted', messageId: 'message-id', started: false, kind: 'periodic', epoch: 0 };
  const f = await fixture(defaults, { captureInFlight: flight });
  const before = await files.readFile(f.store.path);
  await f.invoke('interval 100');
  assert.equal(f.statuses.at(-1).label, 'queued');
  assert.deepEqual(await files.readFile(f.store.path), before);
  const pressureState = { ...f.state, captureInFlight: null, pressurePending: true };
  assert.equal(eligibility(pressureState, await f.bridge.readConfig(), now), 'pressure');
});

test('invalid command only warns, inspection reports current saved value, and reload reads it', async () => {
  const f = await fixture();
  const before = await files.readFile(f.path);
  await f.invoke('interval 0');
  assert.deepEqual(await files.readFile(f.path), before);
  assert.equal(f.logs.at(-1).options.level, 'warning');
  await f.invoke('interval 100');
  await f.invoke('help');
  assert.match(f.logs.at(-1).message, /100K tokens; minimum time: 60m/);
  const restarted = bridgeCommand(f.path, () => f.bridge);
  await restarted.handler({ sessionId: f.session.sessionId, args: 'interval' });
  assert.match(f.logs.at(-1).message, /100K/);
});

test('native completion description advertises supported operations, units and global scope', async () => {
  const f = await fixture();
  assert.match(f.command.description, /help \| interval <K>/);
  assert.match(f.command.description, /Global setting/);
  assert.match(f.command.description, /interval 100 = 100K/);
});

test('all help and inspection forms list operations and examples without changing settings or history', async () => {
  const f = await fixture();
  const configBefore = await files.readFile(f.path);
  const stateBefore = await files.readFile(f.store.path);
  for (const args of ['help', '--help', '-h', 'interval']) {
    await f.invoke(args);
    const { message, options } = f.logs.at(-1);
    assert.equal(options.level, 'info');
    assert.match(message, /periodic interval: 50K tokens; minimum time: 60m/);
    assert.match(message, /Supported operations:/);
    assert.match(message, /\/bm-bridge help/);
    assert.match(message, /\/bm-bridge interval <K>/);
    assert.match(message, /interval 100 = 100,000 tokens/);
    assert.match(message, /Session overrides, reset and --global are not supported/);
    assert.match(message, /Time cooldowns, pressure rules and checkpoint history stay unchanged/);
    assert.match(message, /press Enter for the menu/);
  }
  assert.deepEqual(await files.readFile(f.path), configBefore);
  assert.deepEqual(await files.readFile(f.store.path), stateBefore);
  assert.equal(f.statuses.length, 0);
});

test('invalid commands point to discoverable help without applying a supported prefix', async () => {
  const f = await fixture();
  const before = await files.readFile(f.path);
  for (const args of ['interval 100 --global', 'help extra', 'interval reset', 'unknown']) {
    await f.invoke(args);
    assert.equal(f.logs.at(-1).options.level, 'warning');
    assert.match(f.logs.at(-1).message, /Run \/bm-bridge help/);
  }
  assert.deepEqual(await files.readFile(f.path), before);
});

test('help remains available when installed settings cannot be read or validated', async () => {
  const f = await fixture();
  await files.writeFile(f.path, '{invalid');
  await f.invoke('help');
  assert.equal(f.logs.at(-1).options.level, 'warning');
  assert.match(f.logs.at(-1).message, /configuration could not be read or is invalid/);
  assert.match(f.logs.at(-1).message, /Supported operations:/);
  assert.match(f.logs.at(-1).message, /\/bm-bridge interval <K>/);
  assert.equal(await files.readFile(f.path, 'utf8'), '{invalid');
  assert.equal(f.statuses.length, 0);
});

test('bare command opens a described native menu and cancellation changes nothing', async () => {
  const f = await fixture();
  const before = await files.readFile(f.path);
  const stateBefore = await files.readFile(f.store.path);
  await f.invoke('');
  assert.equal(f.dialogs.length, 1);
  assert.deepEqual(f.dialogs[0].choices, ['Change interval', 'Current settings', 'Help']);
  assert.match(f.dialogs[0].message, /Current periodic interval: 50K/);
  assert.match(f.dialogs[0].message, /all sessions sharing/);
  assert.match(f.dialogs[0].message, /Change interval: choose/);
  assert.equal(f.logs.length, 0);
  assert.equal(f.statuses.length, 0);
  assert.deepEqual(await files.readFile(f.path), before);
  assert.deepEqual(await files.readFile(f.store.path), stateBefore);
});

test('menu interval form uses the current value and the existing validated update path', async () => {
  const f = await fixture();
  const stateBefore = await files.readFile(f.store.path);
  f.select('Change interval');
  f.input('100');
  await f.invoke('  ');
  assert.equal(f.dialogs.length, 2);
  assert.equal(f.dialogs[1].options.default, '50');
  assert.match(f.dialogs[1].options.description, /Applies to all sessions/);
  assert.equal(JSON.parse(await files.readFile(f.path)).periodicMinimumNewTokens, 100000);
  assert.equal(f.statuses.at(-1).targets[0].tokens, 101000);
  assert.deepEqual(await files.readFile(f.store.path), stateBefore);
  assert.match(f.logs.at(-1).message, /interval set to 100K/);
});

test('cancelling interval input or submitting invalid input leaves settings untouched', async () => {
  const f = await fixture();
  const before = await files.readFile(f.path);
  f.select('Change interval');
  await f.invoke('');
  assert.equal(f.logs.length, 0);
  assert.deepEqual(await files.readFile(f.path), before);
  for (const value of ['', '0', '-1', '1.5', '100 --global']) {
    f.input(value);
    await f.invoke('');
    assert.equal(f.logs.at(-1).options.level, 'warning');
    assert.match(f.logs.at(-1).message, /Usage:/);
    assert.deepEqual(await files.readFile(f.path), before);
  }
  assert.equal(f.statuses.length, 0);
});

test('menu settings and help expose current details while preserving inline operations', async () => {
  const f = await fixture();
  const before = await files.readFile(f.path);
  for (const selected of ['Current settings', 'Help']) {
    f.select(selected);
    await f.invoke('');
    assert.match(f.logs.at(-1).message, /Supported operations:/);
    assert.match(f.logs.at(-1).message, /Pressure: 65%; minimum time: 5m/);
    assert.match(f.logs.at(-1).message, /minimum time: 60m/);
    assert.deepEqual(await files.readFile(f.path), before);
  }
  const dialogCount = f.dialogs.length;
  await f.invoke('interval 100');
  assert.equal(f.dialogs.length, dialogCount);
  assert.equal(JSON.parse(await files.readFile(f.path)).periodicMinimumNewTokens, 100000);
});

test('menu requires UI capability but inline commands remain usable without it', async () => {
  const f = await fixture();
  f.session.capabilities.ui.elicitation = false;
  await f.invoke('');
  assert.equal(f.dialogs.length, 0);
  assert.equal(f.logs.at(-1).options.level, 'warning');
  assert.match(f.logs.at(-1).message, /requires an interactive Copilot UI/);
  await f.invoke('help');
  assert.match(f.logs.at(-1).message, /Supported operations:/);
  await f.invoke('interval 100');
  assert.equal(JSON.parse(await files.readFile(f.path)).periodicMinimumNewTokens, 100000);
});

test('menu failures are explicit and sanitized rather than changing configuration', async () => {
  const f = await fixture();
  const before = await files.readFile(f.path);
  f.session.ui.select = async () => { throw new Error('private-ui-error'); };
  await f.invoke('');
  assert.equal(f.logs.at(-1).options.level, 'warning');
  assert.match(f.logs.at(-1).message, /action menu failed. No settings changed/);
  assert.ok(!f.logs.at(-1).message.includes('private-ui-error'));
  assert.deepEqual(await files.readFile(f.path), before);
});

test('menu configuration failure shows available inline help without opening a misleading dialog', async () => {
  const f = await fixture();
  await files.writeFile(f.path, '{invalid');
  await f.invoke('');
  assert.equal(f.dialogs.length, 0);
  assert.equal(f.logs.at(-1).options.level, 'warning');
  assert.match(f.logs.at(-1).message, /Supported operations:/);
  assert.equal(await files.readFile(f.path, 'utf8'), '{invalid');
});

test('startup/session mismatch errors are explicit and cannot change configuration', async () => {
  const f = await fixture();
  const before = await files.readFile(f.path);
  await assert.rejects(bridgeCommand(f.path, () => null).handler({ args: 'interval 100' }), /still attaching/);
  await assert.rejects(f.command.handler({ sessionId: 'another-session', args: 'interval 100' }), /does not match/);
  assert.deepEqual(await files.readFile(f.path), before);
});

test('confirmation failure reports the saved update without leaking native error details', async () => {
  const f = await fixture();
  f.session.log = async () => { throw new Error('private-native-error'); };
  await assert.rejects(f.invoke('interval 100'), error =>
    error.message === 'Interval was saved, but command confirmation could not be displayed.');
  assert.equal(JSON.parse(await files.readFile(f.path)).periodicMinimumNewTokens, 100000);
});
