import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { handleHook } from '../scripts/memory-hook.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, 'scripts', 'memory-hook.mjs');
const defaults = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
const artifacts = join(root, '.test-artifacts');
await mkdir(artifacts, { recursive: true });
const run = await mkdtemp(join(artifacts, 'unit-'));
const start = Date.parse('2026-10-07T20:00:00Z');

async function fixture(config = {}, size = 100, prime = true) {
  const directory = await mkdtemp(join(run, 'case-'));
  const configPath = join(directory, 'config.json');
  const dataDir = join(directory, 'data with spaces');
  const transcriptPath = join(directory, 'synthetic-transcript.jsonl');
  const cwd = join(directory, 'not-a-repository');
  await mkdir(cwd);
  await writeFile(configPath, JSON.stringify({ ...defaults, ...config }));
  await writeFile(transcriptPath, '');
  const event = { sessionId: 'test-session', timestamp: start, cwd, transcriptPath, stopReason: 'end_turn', stop_hook_active: false };
  const statePath = join(dataDir, 'sessions', `${createHash('sha256').update(event.sessionId).digest('hex')}.json`);
  const logs = [];
  const options = { configPath, dataDir, now: start, log: record => logs.push(record) };
  const result = {
    event, options, statePath, logs, directory,
    stop: (changes = {}, now = start) => handleHook('agentStop', { ...event, ...changes }, { ...options, now }),
    compact: (now = start) => handleHook('preCompact', event, { ...options, now }),
    state: async () => JSON.parse(await readFile(statePath, 'utf8')),
    grow: size => truncate(transcriptPath, size),
  };
  if (prime) await result.stop();
  logs.length = 0;
  await truncate(transcriptPath, size);
  return result;
}

test('first stop baselines startup overhead, even beyond thresholds', async () => {
  const f = await fixture({}, 62724, false);
  assert.deepEqual(await f.stop(), {});
  assert.equal((await f.state()).baselineTranscriptBytes, 62724);
  assert.equal((await f.state()).lastCapturePromptBytes, 0);
  await f.grow(82723);
  assert.deepEqual(await f.stop(), {});
  await f.grow(82724);
  assert.equal((await f.stop()).decision, 'block');
});

test('short interaction writes metadata and no continuation', async () => {
  const f = await fixture();
  assert.deepEqual(await f.stop(), {});
  assert.equal((await f.state()).lastObservedTranscriptBytes, 100);
  assert.equal((await f.state()).lastCapturePromptAt, null);
  assert.deepEqual(f.logs, []);
});

test('exact size threshold triggers once; a continuation never blocks', async () => {
  const f = await fixture({}, 30000);
  const result = await f.stop();
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /memory-capture skill/);
  assert.match(result.reason, /copilot:test-session/);
  assert.match(result.reason, /metadata_filters\.thread_id/);
  assert.match(result.reason, /nothing substantial/);
  assert.match(result.reason, /not a transcript/);
  const state = await f.state();
  assert.equal(state.lastCapturePromptBytes, 30000);
  assert.equal(state.lastCapturePromptAt, new Date(start).toISOString());
  await f.grow(100000);
  assert.deepEqual(await f.stop({ stop_hook_active: true }, start + 3600000), {});
  assert.deepEqual(await f.state(), state);
});

test('normal gate needs size AND delta AND elapsed time, including exact boundaries', async () => {
  const f = await fixture({}, 29999);
  assert.deepEqual(await f.stop(), {});
  await f.grow(30000);
  assert.equal((await f.stop()).decision, 'block');
  await f.grow(49999);
  assert.deepEqual(await f.stop({}, start + 1800000), {});
  await f.grow(50000);
  assert.deepEqual(await f.stop({}, start + 1800000 - 1), {});
  assert.equal((await f.stop({}, start + 1800000)).decision, 'block');
  assert.equal((await f.state()).lastCapturePromptBytes, 50000);
});

test('minimum delta can be higher than minimum total size', async () => {
  const f = await fixture({ minimumDeltaBytes: 40000 }, 30000);
  assert.deepEqual(await f.stop(), {});
  await f.grow(40000);
  assert.equal((await f.stop()).decision, 'block');
});

test('preCompact records a timestamp without statting a transcript', async () => {
  const f = await fixture();
  const result = await handleHook('preCompact', { sessionId: f.event.sessionId }, f.options);
  assert.deepEqual(result, {});
  assert.equal((await f.state()).preCompactSeen, true);
  assert.equal((await f.state()).preCompactAt, new Date(start).toISOString());
});

test('preCompact bypasses both size and cooldown and clears only after offering', async () => {
  const f = await fixture({}, 30000);
  await f.stop();
  await f.compact(start + 1);
  assert.deepEqual(await f.stop({ stop_hook_active: true }, start + 2), {});
  assert.equal((await f.state()).preCompactSeen, true);
  await f.grow(10);
  assert.equal((await f.stop({}, start + 3)).decision, 'block');
  assert.equal((await f.state()).preCompactSeen, false);
  assert.deepEqual(await f.stop({}, start + 4), {});
});

test('preCompact can offer a checkpoint on the first stop', async () => {
  const f = await fixture({}, 100, false);
  await f.compact();
  assert.equal((await f.stop()).decision, 'block');
});

test('captureAfterPreCompact false does not override the size gate', async () => {
  const f = await fixture({ captureAfterPreCompact: false });
  await f.compact();
  assert.deepEqual(await f.stop(), {});
  assert.equal((await f.state()).preCompactSeen, true);
});

test('enabled false has no state side effects, even with a pending compaction', async () => {
  const f = await fixture({ enabled: false }, 100000);
  assert.deepEqual(await f.compact(), {});
  assert.deepEqual(await f.stop(), {});
  await assert.rejects(stat(f.statePath), { code: 'ENOENT' });
});

test('partial disable config inherits defaults', async () => {
  const f = await fixture({}, 100, false);
  await writeFile(f.options.configPath, '{"enabled":false}');
  assert.deepEqual(await f.stop(), {});
  await assert.rejects(stat(f.statePath), { code: 'ENOENT' });
});

test('zero thresholds still cannot recurse on stop_hook_active', async () => {
  const f = await fixture({ minimumTranscriptBytes: 0, minimumDeltaBytes: 0, minimumMinutesBetweenPrompts: 0 }, 0);
  assert.equal((await f.stop()).decision, 'block');
  assert.deepEqual(await f.stop({ stop_hook_active: true }), {});
});

for (const guard of [undefined, null, 'false', 0]) {
  test(`missing or malformed continuation guard ${JSON.stringify(guard)} fails open`, async () => {
    const f = await fixture({}, 100000);
    assert.deepEqual(await f.stop({ stop_hook_active: guard }), {});
    assert.equal((await f.state()).lastCapturePromptAt, null);
  });
}

test('corrupt state is recreated without prompting on the recovery stop', async () => {
  const f = await fixture({}, 30000);
  await f.stop();
  await writeFile(f.statePath, '{broken');
  assert.deepEqual(await f.stop(), {});
  assert.equal((await f.state()).lastObservedTranscriptBytes, 30000);
  assert.equal((await f.state()).baselineTranscriptBytes, 30000);
  assert.match(f.logs.at(-1).gateDecision, /state-recovered/);
  await f.grow(50000);
  assert.equal((await f.stop()).decision, 'block');
});

test('invalid or cross-session state is never trusted', async () => {
  const f = await fixture({}, 30000);
  await f.stop();
  const state = await f.state();
  for (const changes of [{ sessionId: 'other' }, { lastCapturePromptBytes: -1 }, { lastCapturePromptAt: 'tomorrow' }, { preCompactSeen: 'yes' }]) {
    await writeFile(f.statePath, JSON.stringify({ ...state, ...changes }));
    assert.deepEqual(await f.stop(), {});
    assert.equal((await f.state()).lastCapturePromptAt, null);
  }
});

test('unreadable state fails open without replacing it', async () => {
  const f = await fixture({}, 30000, false);
  await mkdir(f.statePath, { recursive: true });
  assert.deepEqual(await f.stop(), {});
  assert.equal((await stat(f.statePath)).isDirectory(), true);
});

test('missing, relative, or non-file transcript fails open, retaining compaction', async () => {
  const f = await fixture({}, 30000);
  await f.compact();
  for (const path of [undefined, 'relative.jsonl', join(f.directory, 'missing'), f.directory]) {
    assert.deepEqual(await f.stop({ transcriptPath: path }), {});
    assert.equal((await f.state()).preCompactSeen, true);
    assert.match(f.logs.at(-1).gateDecision, /transcript-error/);
  }
});

test('unwritable state directory never emits block', async () => {
  const f = await fixture({}, 30000, false);
  await writeFile(f.options.dataDir, 'not a directory');
  assert.deepEqual(await f.stop(), {});
  assert.match(f.logs.at(-1).gateDecision, /state-error/);
});

test('missing plugin data path fails open; never falls back to CWD', async () => {
  const f = await fixture({}, 30000, false);
  assert.deepEqual(await handleHook('agentStop', f.event, { ...f.options, dataDir: '' }), {});
  await assert.rejects(stat(f.statePath), { code: 'ENOENT' });
});

for (const value of ['{broken', 'null', '{"enabled":"true"}', '{"minimumDeltaBytes":-1}', '{"minimumMinutesBetweenPrompts":"0"}', '{"minimumTranscriptBytes":1.5}', '{"typo":true}']) {
  test(`invalid config fails open: ${value}`, async () => {
    const f = await fixture({}, 100000);
    await writeFile(f.options.configPath, value);
    assert.deepEqual(await f.stop(), {});
    assert.match(f.logs.at(-1).gateDecision, /config-error/);
  });
}

test('transcript shrink rebases byte threshold without resetting cooldown', async () => {
  const f = await fixture({}, 100000);
  await f.stop();
  await f.grow(10);
  assert.deepEqual(await f.stop({}, start + 1), {});
  assert.equal((await f.state()).lastCapturePromptBytes, 0);
  await f.grow(30000);
  assert.deepEqual(await f.stop({}, start + 2), {});
  assert.equal((await f.stop({}, start + 1800000)).decision, 'block');
});

test('clock going backwards does not bypass cooldown', async () => {
  const f = await fixture({}, 30000);
  await f.stop();
  await f.grow(100000);
  assert.deepEqual(await f.stop({}, start - 1), {});
});

test('two sessions have isolated state', async () => {
  const f = await fixture({}, 30000);
  assert.equal((await f.stop()).decision, 'block');
  await f.grow(0);
  assert.deepEqual(await f.stop({ sessionId: 'other-session' }), {});
  await f.grow(30000);
  assert.equal((await f.stop({ sessionId: 'other-session' })).decision, 'block');
  assert.deepEqual(await f.stop(), {});
  assert.equal((await readdir(dirname(f.statePath))).filter(name => name.endsWith('.json')).length, 2);
});

test('overlapping hooks cannot both offer a checkpoint', async () => {
  const f = await fixture({}, 30000);
  const results = await Promise.all([f.stop(), f.stop()]);
  assert.equal(results.filter(result => result.decision === 'block').length, 1);
  assert.equal((await readdir(dirname(f.statePath))).length, 1);
});

test('busy or leftover lock fails open without removing another invocation lock', async () => {
  const f = await fixture({}, 30000);
  await mkdir(dirname(f.statePath), { recursive: true });
  await writeFile(`${f.statePath}.lock`, 'another invocation');
  assert.deepEqual(await f.stop(), {});
  assert.equal(await readFile(`${f.statePath}.lock`, 'utf8'), 'another invocation');
});

test('only operational metadata is logged or saved; transcript content is never read', async () => {
  const f = await fixture({ debugLogging: true });
  const secret = 'SYNTHETIC-CONTENT-MUST-NOT-LEAK';
  await writeFile(f.event.transcriptPath, secret.repeat(2000));
  const result = await f.stop({ prompt: secret, environment: { secret } });
  assert.equal(result.decision, 'block');
  const state = await f.state();
  assert.deepEqual(Object.keys(state), [
    'sessionId', 'baselineTranscriptBytes', 'lastObservedTranscriptBytes', 'lastCapturePromptBytes',
    'lastCapturePromptAt', 'preCompactSeen', 'preCompactAt',
  ]);
  for (const row of f.logs) {
    assert.ok(Object.keys(row).every(key => ['timestamp', 'event', 'sessionId', 'transcriptBytes', 'gateDecision'].includes(key)));
  }
  assert.ok(!JSON.stringify([result, state, f.logs]).includes(secret));
});

test('bad event/session identifiers cannot escape state directory', async () => {
  const f = await fixture({}, 30000);
  for (const id of ['..\\escape', '../escape', '', 'x\ninstructions', 'a'.repeat(129)]) {
    assert.deepEqual(await f.stop({ sessionId: id }), {});
  }
  assert.deepEqual(await handleHook('subagentStop', f.event, f.options), {});
});

test('out-of-repository capture is supported without Git provenance', async () => {
  const f = await fixture({}, 30000);
  const result = await f.stop({ cwd: tmpdir() });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /"cwd":/);
  assert.ok(!result.reason.includes('"repo":'));
  assert.ok(!result.reason.includes('"branch":'));
});

test('repository/branch provenance is deterministic and optional', async () => {
  const f = await fixture({}, 30000);
  const result = await f.stop({ cwd: root });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /"repo":/);
  assert.match(result.reason, /"branch":/);
});

test('CLI stdin/stdout is exactly one JSON object and errors exit zero', async () => {
  const f = await fixture();
  for (const input of [JSON.stringify(f.event), '{broken', '', 'null']) {
    const result = spawnSync(process.execPath, [script, 'agentStop'], {
      input, encoding: 'utf8', env: { ...process.env, COPILOT_PLUGIN_DATA: f.options.dataDir },
    });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), {});
  }
});

test('real Windows PowerShell hook command passes stdin and paths with spaces', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture();
  const pluginRoot = join(f.directory, "plugin $test's root");
  await mkdir(join(pluginRoot, 'scripts'), { recursive: true });
  await copyFile(script, join(pluginRoot, 'scripts', 'memory-hook.mjs'));
  await copyFile(join(root, 'config.json'), join(pluginRoot, 'config.json'));
  const hooks = JSON.parse(await readFile(join(root, 'com.github.copilot', 'hooks', 'hooks.json'), 'utf8'));
  for (const event of ['agentStop', 'preCompact']) {
    const hook = hooks.hooks[event][0];
    assert.deepEqual(Object.keys(hook).sort(), ['powershell', 'timeoutSec', 'type']);
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', hook.powershell], {
      input: JSON.stringify(f.event), encoding: 'utf8', timeout: 10000,
      env: { ...process.env, COPILOT_PLUGIN_ROOT: pluginRoot, COPILOT_PLUGIN_DATA: f.options.dataDir },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
  }
  assert.equal((await f.state()).preCompactSeen, true);
});
