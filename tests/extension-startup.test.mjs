import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifacts = join(root, '.test-artifacts');
await mkdir(artifacts, { recursive: true });
const run = await mkdtemp(join(artifacts, 'extension-startup-'));
const entrySource = process.env.BRIDGE_ENTRY_TEST_SOURCE ?? join(root, 'extension', 'extension.mjs');
const privateText = 'PRIVATE_FIXTURE_DIAGNOSTIC_CONTENT';

const resolver = `
import { pathToFileURL } from 'node:url';
export async function resolve(specifier, context, next) {
  if (specifier === '@github/copilot-sdk/extension') {
    return { url: pathToFileURL(process.env.BRIDGE_TEST_SDK).href, shortCircuit: true };
  }
  return next(specifier, context);
}
`;
const bootstrap = `
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
register(pathToFileURL(process.env.BRIDGE_TEST_RESOLVER).href);
await import(pathToFileURL(process.env.BRIDGE_TEST_ENTRY).href);
`;
const sdk = `
const mode = process.env.BRIDGE_TEST_MODE;
setInterval(() => {}, 1000);
const failure = () => Object.assign(new Error('${privateText}'), {
  code: mode === 'sdk-error' ? 'ERR_MODULE_NOT_FOUND' : -32603,
  data: '${privateText}',
});
if (mode === 'sdk-error') throw failure();
if (mode === 'sdk-held') {
  console.error(JSON.stringify({ fixtureHeld: true }));
  await new Promise(() => {});
}
export async function joinSession(options) {
  if (mode === 'join-held') {
    console.error(JSON.stringify({ fixtureHeld: true }));
    await new Promise(() => {});
  }
  if (mode === 'join-error') throw failure();
  if (options.commands?.[0]?.name !== 'bm-bridge') throw failure();
  return {
    sessionId: 'entry-startup-fixture',
    log: async () => {
      if (mode === 'snapshot-error' || mode === 'snapshot-held') {
        console.error(JSON.stringify({ fixtureUnexpectedTimelineLog: true }));
      }
    },
    on: () => () => {},
    rpc: { metadata: {
      snapshot: async () => {
        if (mode === 'snapshot-error' || mode === 'snapshot-held') {
          console.error(JSON.stringify({ fixtureSnapshotAttempt: true }));
          if (mode === 'snapshot-error') throw failure();
          await new Promise(() => {});
        }
        return { workingDirectory: process.cwd() };
      },
      contextInfo: async () => {
        if (mode === 'initialize-error') throw failure();
        return { contextInfo: { totalTokens: 1000, limit: 200000 } };
      },
    } },
  };
}
`;

async function exercise(mode, expected) {
  const directory = await mkdtemp(join(run, 'case-'));
  const home = join(directory, 'home');
  await mkdir(home);
  for (const name of ['bridge.mjs', 'commands.mjs', 'status-publisher.mjs', 'config.json']) {
    await copyFile(join(root, 'extension', name), join(directory, name));
  }
  await copyFile(entrySource, join(directory, 'extension.mjs'));
  if (mode === 'bridge-error') {
    await writeFile(join(directory, 'bridge.mjs'), `throw new SyntaxError('${privateText}');`);
  }
  await writeFile(join(directory, 'resolver.mjs'), resolver);
  await writeFile(join(directory, 'bootstrap.mjs'), bootstrap);
  await writeFile(join(directory, 'sdk.mjs'), sdk);
  const child = spawn(process.execPath, [join(directory, 'bootstrap.mjs')], {
    cwd: directory,
    env: {
      ...process.env,
      COPILOT_HOME: home,
      COPILOT_SDK_PATH: join(directory, 'private-sdk-parent', '1.0.112', 'copilot-sdk'),
      BRIDGE_TEST_MODE: mode,
      BRIDGE_TEST_SDK: join(directory, 'sdk.mjs'),
      BRIDGE_TEST_ENTRY: join(directory, 'extension.mjs'),
      BRIDGE_TEST_RESOLVER: join(directory, 'resolver.mjs'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  let stdout = '';
  let timer;
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  const observed = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`startup-marker-missing:${mode}`)), 8000);
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.includes(expected)) resolve();
    });
    child.once('error', reject);
  });
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  try {
    await observed;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  }
  assert.equal(stdout, '', 'Startup diagnostics must not corrupt the SDK stdout transport.');
  assert.ok(!stderr.includes(privateText), 'Do not log exception messages, causes or payloads.');
  assert.ok(!stderr.includes('private-sdk-parent'), 'Do not log raw SDK environment paths.');
  const rows = stderr.trim().split('\n').map(line => JSON.parse(line));
  const startup = rows.filter(row => row.event === 'startup');
  return { directory, home, rows, startup, stderr };
}

test('entry module records dependency loading, attachment and actual bridge readiness in order', async () => {
  const f = await exercise('success', '"gateDecision":"bridge-ready"');
  assert.deepEqual(f.startup.map(row => row.gateDecision), [
    'entry', 'sdk-import-start', 'sdk-import-complete',
    'bridge-import-start', 'bridge-import-complete',
    'status-import-start', 'status-import-complete',
    'commands-import-start', 'commands-import-complete',
    'session-join-start', 'session-join-complete',
    'bridge-initialize-start', 'bridge-ready',
  ]);
  for (const [index, row] of f.startup.entries()) {
    assert.ok(Number.isFinite(Date.parse(row.timestamp)));
    assert.ok(row.elapsedMs >= (f.startup[index - 1]?.elapsedMs ?? 0));
  }
  assert.equal(f.startup[0].sdkVersion, '1.0.112');
  const saved = await readFile(join(f.home, 'extension-state', 'basic-memory-bridge', 'logs',
    'entry-startup-fixture.jsonl'), 'utf8');
  assert.ok(saved.includes('"gateDecision":"attached"'));
});

test('entry module retains a last-started stage when dependency loading or attachment stalls', async t => {
  for (const [mode, stage] of [['sdk-held', 'sdk-import-start'], ['join-held', 'session-join-start']]) {
    await t.test(mode, async () => {
      const f = await exercise(mode, '"fixtureHeld":true');
      assert.equal(f.startup.at(-1).gateDecision, stage);
      assert.ok(!f.startup.some(row => row.gateDecision === 'bridge-ready'));
    });
  }
});

test('entry module reports rejected imports and attachment without exposing private error text', async t => {
  for (const [mode, stage, code] of [
    ['sdk-error', 'sdk-import-start', 'ERR_MODULE_NOT_FOUND'],
    ['bridge-error', 'bridge-import-start', 'UNKNOWN'],
    ['join-error', 'session-join-start', -32603],
  ]) {
    await t.test(mode, async () => {
      const f = await exercise(mode, '"gateDecision":"connection-error"');
      const failure = f.startup.at(-1);
      assert.equal(failure.failedStage, stage);
      assert.equal(failure.code, code);
      assert.ok(!f.startup.some(row => row.gateDecision === 'bridge-ready'));
    });
  }
});

test('entry module does not claim readiness when native bridge initialization fails', async () => {
  const f = await exercise('initialize-error', '"gateDecision":"bridge-not-ready"');
  assert.ok(f.startup.some(row => row.gateDecision === 'session-join-complete'));
  assert.ok(!f.startup.some(row => row.gateDecision === 'bridge-ready'));
  const log = await readFile(join(f.home, 'extension-state', 'basic-memory-bridge', 'logs',
    'entry-startup-fixture.jsonl'), 'utf8');
  assert.ok(log.includes('"operation":"metadata.context-info"'));
});

test('entry reaches readiness after a rejected or timed-out optional snapshot without timeline RPCs', async t => {
  for (const [mode, code] of [['snapshot-error', -32603], ['snapshot-held', 'RPC_TIMEOUT']]) {
    await t.test(mode, async () => {
      const f = await exercise(mode, '"gateDecision":"bridge-ready"');
      assert.equal(f.startup.at(-1).gateDecision, 'bridge-ready');
      const failure = f.rows.find(row => row.gateDecision === 'startup-context-unavailable');
      assert.equal(failure.operation, 'metadata.snapshot');
      assert.equal(failure.code, code);
      assert.equal(failure.phase, 'initialization');
      assert.equal(f.rows.filter(row => row.fixtureSnapshotAttempt).length, 1);
      assert.ok(!f.rows.some(row => row.fixtureUnexpectedTimelineLog));
    });
  }
});
