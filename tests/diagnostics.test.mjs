import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CaptureBridge, defaults, freshState } from '../extension/bridge.mjs';
import { createDiagnostics } from '../extension/diagnostics.mjs';
import { createLogger, loadUtilities, settleLogger } from './helpers/diagnostics.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(root, '.test-artifacts'), { recursive: true });
const run = await mkdtemp(join(root, '.test-artifacts', 'logging-'));

function fixture(logger, snapshot = async () => ({ workingDirectory: 'private-cwd' })) {
  const warnings = [];
  const state = freshState('logging-fixture');
  const session = {
    sessionId: state.sessionId,
    log: async (message, options) => warnings.push({ message, options }),
    rpc: { metadata: {
      snapshot,
      contextInfo: async () => ({ contextInfo: { totalTokens: 1000, limit: 200000 } }),
    } },
  };
  const bridge = new CaptureBridge({
    session, store: { transaction: async action => action(state, false) },
    config: async () => defaults, log: logger,
  });
  return { bridge, warnings };
}

test('bootstrap handoff preserves initial readiness and failure evidence once without a startup gate', { timeout: 5000 }, async t => {
  for (const mode of ['ready', 'failed']) {
    await t.test(mode, async t => {
      const loaded = Promise.withResolvers();
      const directory = await mkdtemp(join(run, 'cold-load-'));
      const logger = createLogger(directory, 'logging-fixture', Date.now, { load: () => loaded.promise });
      t.after(() => logger.close());
      const failure = Object.assign(new Error('private-metadata-payload'), { code: -32603 });
      const f = mode === 'failed' ? fixture(logger, async () => { throw failure; }) : fixture(logger);
      await f.bridge.start();
      assert.equal(f.bridge.ready, mode === 'ready');
      if (mode === 'ready') {
        const value = {};
        assert.equal(await f.bridge.diagnose('metadata.activity', async () => value), value);
        await assert.rejects(f.bridge.diagnose('metadata.snapshot', () => { throw failure; }), error => error === failure);
        await f.bridge.warn('event', failure);
      }
      loaded.resolve(await loadUtilities());
      await settleLogger(logger);
      const rows = (await readFile(join(directory, 'logging-fixture.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      if (mode === 'ready') assert.equal(rows.filter(record => record.gateDecision === 'attached').length, 1);
      assert.equal(rows.filter(record => record.operation === 'metadata.snapshot' && record.code === -32603).length, 1);
    });
  }
});

test('bootstrap limits sanitized UTF-8 records and counts record and byte overflow separately', async t => {
  for (const mode of ['records', 'bytes']) {
    await t.test(mode, async t => {
      const logger = createDiagnostics({
        path: join(await mkdtemp(join(run, 'bootstrap-bounds-')), 'fixture.jsonl'),
        sessionId: 'logging-fixture', clock: Date.now, codes: [],
        format: record => ({ ...record, timestamp: new Date().toISOString(), sessionId: 'logging-fixture' }),
        suppressionKey: () => undefined, load: () => new Promise(() => {}), fallback: () => {},
      });
      t.after(() => logger.close());
      for (let index = 0; index < 20; index++) {
        logger({ event: 'fixture', gateDecision: 'metadata', index,
          ...(mode === 'bytes' && { label: '\u00e9'.repeat(600) }) });
      }
      const health = logger.getHealth().bootstrap;
      assert.ok(health.pending <= 16 && health.bytes <= 16_384);
      if (mode === 'records') {
        assert.equal(health.pending, 16);
        assert.equal(health.recordOverflow, 4);
      } else {
        assert.ok(health.pending < 16);
        assert.ok(health.byteOverflow > 0);
      }
    });
  }
});

test('bootstrap rejection retains original numeric failure separately from import failure', async t => {
  const loaded = Promise.withResolvers();
  const fallbacks = [];
  const logger = createLogger(await mkdtemp(join(run, 'bootstrap-rejected-')), 'logging-fixture', Date.now, {
    load: () => loaded.promise, fallback: value => fallbacks.push(JSON.parse(value)),
  });
  t.after(() => logger.close());
  const failure = Object.assign(new Error('private-sdk-payload'), { code: -32603 });
  const f = fixture(logger, async () => { throw failure; });
  await f.bridge.start();
  loaded.reject(Object.assign(new Error('private-module-path'), { code: 'ERR_MODULE_NOT_FOUND' }));
  assert.equal(await logger.ready, false);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(logger.getHealth().bootstrap.importDiscarded > 0);
  const report = fallbacks.find(value => value.original?.code === -32603);
  assert.equal(report.original.operation, 'metadata.snapshot');
  assert.equal(report.diagnosticFailure.code, 'ERR_MODULE_NOT_FOUND');
  assert.ok(!JSON.stringify(fallbacks).includes('private'));
});

test('bootstrap preserves admission timestamps and accounts for a refused one-time handoff', async t => {
  const loaded = Promise.withResolvers();
  const records = [];
  let now = Date.parse('2026-10-08T10:00:00Z');
  const logger = createLogger(await mkdtemp(join(run, 'bootstrap-refused-')), 'logging-fixture', () => now, {
    load: () => loaded.promise, capacity: 1, write: async record => { records.push(record); },
  });
  t.after(() => logger.close());
  const timestamp = new Date(now).toISOString();
  for (let epoch = 0; epoch < 2; epoch++) {
    assert.equal(logger({ event: 'session.compaction_complete', gateDecision: 'epoch-reset', compactionEpoch: epoch }), 1);
  }
  now += 60000;
  loaded.resolve(await loadUtilities());
  await settleLogger(logger);
  assert.equal(records.length, 1);
  assert.equal(records[0].timestamp, timestamp);
  assert.equal(logger.getHealth().bootstrap.forwarded, 1);
  assert.equal(logger.getHealth().bootstrap.handoffRefused, 1);
});

test('bootstrap shutdown discards admission and a late import cannot activate delivery', async () => {
  const loaded = Promise.withResolvers();
  const logger = createLogger(await mkdtemp(join(run, 'bootstrap-shutdown-')), 'logging-fixture', Date.now, {
    load: () => loaded.promise,
  });
  assert.equal(logger({ event: 'startup', gateDecision: 'attached' }), 1);
  logger.close();
  loaded.resolve(await loadUtilities());
  assert.equal(await logger.ready, false);
  assert.equal(logger.getHealth().bootstrap.shutdownDiscarded, 1);
  assert.equal(logger.getHealth().bootstrap.forwarded, 0);
  assert.equal(logger.getHealth().delivery, undefined);
});

test('failed or held independent reporting stays bounded and cannot delay close', { timeout: 5000 }, async t => {
  for (const mode of ['rejected', 'held']) {
    await t.test(mode, async t => {
      const held = Promise.withResolvers();
      let reports = 0;
      const logger = createLogger(await mkdtemp(join(run, 'reporter-')), 'logging-fixture', Date.now, {
        write: async () => { throw Object.assign(new Error('private-file-path'), { code: 'EIO' }); },
        fallback: value => {
          if (JSON.parse(value).event !== 'bridge') return;
          reports++;
          return mode === 'held' ? held.promise : Promise.reject(new Error('private-reporter-payload'));
        },
      });
      t.after(() => { logger.close(); held.resolve(); });
      await logger.ready;
      logger({ event: 'bridge', gateDecision: 'event-error' });
      await settleLogger(logger);
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      for (let index = 0; index < 5; index++) {
        logger({ event: 'session.compaction_complete', gateDecision: 'epoch-reset', compactionEpoch: index });
      }
      await settleLogger(logger);
      await new Promise(resolve => setImmediate(resolve));
      if (mode === 'held') {
        assert.equal(reports, 1);
        assert.equal(logger.getHealth().reportActive, true);
      } else assert.ok(logger.getHealth().reportFailures > 0);
      logger.close();
      assert.equal(logger.getHealth().closed, true);
    });
  }
});

test('held file delivery cannot delay operation results, warning emission or close', { timeout: 5000 }, async t => {
  const held = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const logger = createLogger(await mkdtemp(join(run, 'held-')), 'logging-fixture', Date.now, {
    write: async () => { entered.resolve(); await held.promise; },
  });
  t.after(() => { logger.close(); held.resolve(); });
  await logger.ready;
  const value = {};
  assert.equal(await logger.trace('metadata.snapshot', async () => value), value);
  const error = Object.assign(new Error('private-sdk-payload'), { code: -32601 });
  const f = fixture(logger, async () => { throw error; });
  await f.bridge.start();
  assert.deepEqual(f.warnings, [{
    message: '[basic-memory-bridge] event failed (metadata.snapshot: -32601, Error); normal session use continues.',
    options: { level: 'warning' },
  }]);
  await entered.promise;
  assert.equal(logger.getHealth().delivery.destinations[0].active, true);
  logger.close();
  assert.equal(logger.getHealth().closed, true);
});

test('file failure reports safe original operation and file cause without replacing the rejection', { timeout: 5000 }, async t => {
  const records = [];
  const fallbacks = [];
  const logger = createLogger(await mkdtemp(join(run, 'failed-')), 'logging-fixture', Date.now, {
    write: async record => {
      records.push(record);
      throw Object.assign(new Error('private-file-path'), { code: 'EACCES' });
    },
    fallback: value => fallbacks.push(JSON.parse(value)),
  });
  t.after(() => logger.close());
  await logger.ready;
  const error = Object.assign(new Error('private-sdk-payload'), { code: -32603 });
  await assert.rejects(logger.trace('session.send', () => { throw error; }, {
    phase: 'event', requestId: 'request-1', compactionEpoch: 7,
  }), value => value === error);
  await settleLogger(logger);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const failure = fallbacks.findLast(value => value.original?.code === -32603);
  assert.equal(failure.original.operation, 'session.send');
  assert.equal(failure.original.requestId, 'request-1');
  assert.equal(failure.original.compactionEpoch, 7);
  assert.equal(failure.original.phase, 'event');
  assert.equal(failure.diagnosticFailure.code, 'EACCES');
  assert.equal(failure.diagnosticFailure.operation, 'diagnostic.write');
  assert.equal(records.length, 1, 'A failed append must not be replayed.');
  const repeat = { event: 'bridge', gateDecision: 'event-error', operation: 'metadata.snapshot',
    code: -32603, errorType: 'Error' };
  logger(repeat);
  await settleLogger(logger);
  logger(repeat);
  await settleLogger(logger);
  assert.equal(records.length, 3, 'Failure must not suppress the next record with the same key.');
  assert.equal(logger.getHealth().delivery.destinations[0].suppressed, 0);
  assert.ok(!JSON.stringify(fallbacks).includes('private'));
});

test('missing, corrupt and held optional utility loads do not gate Bridge readiness', { timeout: 5000 }, async t => {
  for (const [name, load] of [
    ['missing', async () => { throw Object.assign(new Error('private-module-path'), { code: 'ERR_MODULE_NOT_FOUND' }); }],
    ['corrupt', async () => { throw new SyntaxError('private-module-code'); }],
    ['held', () => new Promise(() => {})],
  ]) {
    await t.test(name, async t => {
      const fallbacks = [];
      const logger = createLogger(await mkdtemp(join(run, `${name}-`)), 'logging-fixture', Date.now, {
        load, fallback: value => fallbacks.push(value),
      });
      t.after(() => logger.close());
      const f = fixture(logger);
      await f.bridge.start();
      assert.equal(f.bridge.ready, true);
      assert.deepEqual(f.warnings, []);
      if (name !== 'held') assert.equal(await logger.ready, false);
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(!fallbacks.join('').includes('private'));
    });
  }
});

test('overflow stays bounded while a destination is held', { timeout: 5000 }, async t => {
  const held = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const logger = createLogger(await mkdtemp(join(run, 'bounds-')), 'logging-fixture', Date.now, {
    capacity: 2, write: async () => { entered.resolve(); await held.promise; },
  });
  t.after(() => { logger.close(); held.resolve(); });
  await logger.ready;
  const record = { event: 'session.compaction_complete', gateDecision: 'epoch-reset', compactionEpoch: 1 };
  logger(record);
  await entered.promise;
  for (let index = 0; index < 8; index++) logger({ ...record, compactionEpoch: index + 2 });
  const file = logger.getHealth().delivery.destinations[0];
  assert.equal(file.pending, 2);
  assert.equal(file.overflow, 6);
  logger.close();
});
