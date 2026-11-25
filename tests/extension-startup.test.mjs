import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { utilityFiles } from '../scripts/install.mjs';
import { promisify } from 'node:util';

const execute = promisify(execFile);

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
  const resolved = await next(specifier, context);
  const allowed = pathToFileURL(process.env.BRIDGE_TEST_DIRECTORY).href + '/';
  if (resolved.url.startsWith('file:') && !resolved.url.startsWith(allowed)) throw new Error('outside-fixture-import');
  return resolved;
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
  let entry = join(directory, 'extension.mjs');
  if (mode === 'package-install') {
    assert.ok(process.env.npm_execpath, 'Run the packaged fixture through npm test.');
    const client = join(directory, 'client');
    await mkdir(client);
    await writeFile(join(client, 'package.json'), '{"name":"bridge-runtime-fixture","private":true,"type":"module"}\n');
    await writeFile(join(client, '.npmrc'), 'omit-lockfile-registry-resolved=true\n');
    await execute(process.execPath, [process.env.npm_execpath, 'install', '--install-links', root, '--prefix', client], {
      windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024,
    });
    const tools = join(directory, 'tools');
    await mkdir(tools);
    await writeFile(join(tools, 'copilot.cmd'), '@echo off\r\necho []\r\n');
    await execute(process.execPath, [
      join(client, 'node_modules', 'basic-memory-copilot-bridge', 'scripts', 'install.mjs'),
      '--no-statusline', '--copilot-home', home,
    ], {
      windowsHide: true, timeout: 30000,
      env: { ...process.env, PATH: `${tools};${process.env.PATH}`, COPILOT_HOME: home },
    });
    entry = join(home, 'extensions', 'basic-memory-bridge', 'extension.mjs');
  } else {
    for (const name of ['bridge.mjs', 'commands.mjs', 'status-publisher.mjs', 'diagnostics.mjs', 'config.json']) {
      await copyFile(join(root, 'extension', name), join(directory, name));
    }
    await copyFile(entrySource, entry);
  }
  const utility = fileURLToPath(new URL('../', import.meta.resolve('copilot-extension-utils/diagnostics/trace')));
  if (mode !== 'logging-missing' && mode !== 'package-install') {
    for (const name of utilityFiles) {
      const target = join(directory, 'lib', name);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(utility, name), target);
    }
  }
  if (mode === 'logging-corrupt') {
    await writeFile(join(directory, 'lib', 'diagnostics', 'trace.mjs'), `throw new SyntaxError('${privateText}');`);
  }
  if (mode === 'logging-held') {
    await writeFile(join(directory, 'lib', 'diagnostics', 'trace.mjs'),
      'console.error(JSON.stringify({loggingFixtureHeld:true})); await new Promise(() => {});');
  }
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
      BRIDGE_TEST_ENTRY: entry,
      BRIDGE_TEST_RESOLVER: join(directory, 'resolver.mjs'),
      BRIDGE_TEST_DIRECTORY: mode === 'package-install' ? home : directory,
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
      const loggingObserved = mode === 'logging-held' ? stderr.includes('"loggingFixtureHeld":true')
        : ['logging-missing', 'logging-corrupt'].includes(mode) ? stderr.includes('"gateDecision":"logging-import-error"') : true;
      if (stderr.includes(expected) && loggingObserved) resolve();
    });
    child.once('error', reject);
  });
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  try {
    await observed;
    if (['success', 'initialize-error', 'package-install', 'snapshot-error', 'snapshot-held'].includes(mode)) {
      const path = join(home, 'extension-state', 'basic-memory-bridge', 'logs', 'entry-startup-fixture.jsonl');
      const marker = mode === 'initialize-error' ? '"operation":"metadata.context-info"' : '"gateDecision":"attached"';
      const deadline = Date.now() + 5000;
      while (true) {
        let saved = '';
        try { saved = await readFile(path, 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (saved.includes(marker)) break;
        if (Date.now() >= deadline) throw new Error(`fixture-file-delivery-missing:${mode}`);
        await delay(2);
      }
    }
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    await writeFile(join(directory, 'stderr.log'), stderr);
    await writeFile(join(directory, 'stdout.log'), stdout);
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

test('actual entry stays ready with missing, corrupt or held installed utilities and inaccessible checkout/cache', async t => {
  for (const mode of ['logging-missing', 'logging-corrupt', 'logging-held']) {
    await t.test(mode, async () => {
      const f = await exercise(mode, '"gateDecision":"bridge-ready"');
      assert.equal(f.startup.at(-1).gateDecision, 'bridge-ready');
      if (mode !== 'logging-held') {
        const failure = f.rows.find(row => row.gateDecision === 'logging-import-error');
        assert.equal(failure.code, mode === 'logging-missing' ? 'ERR_MODULE_NOT_FOUND' : 'UNKNOWN');
      }
    });

  }
});

test('standard npm install runs the actual installer and installed entry without checkout/cache imports', { timeout: 150000 }, async () => {
  const f = await exercise('package-install', '"gateDecision":"bridge-ready"');
  assert.equal(f.startup.at(-1).gateDecision, 'bridge-ready');
  for (const name of utilityFiles) {
    const installed = join(f.home, 'extensions', 'basic-memory-bridge', 'lib', name);
    assert.ok((await readFile(installed)).length > 0);
  }
});
