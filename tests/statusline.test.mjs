import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { compose, expandCommand, renderPrevious, renderStatusLine, tokenBadge, validateConfig } from '../statusline/statusline.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifacts = join(root, '.test-artifacts');
await mkdir(artifacts, { recursive: true });
const run = await mkdtemp(join(artifacts, 'statusline-'));
const input = (tokens = 205000, limit = 253000) => ({
  session_id: 'synthetic-session', cwd: root,
  context_window: { current_context_tokens: tokens, displayed_context_limit: limit },
});
const config = { previousStatusLine: { command: 'synthetic-renderer' }, showTokens: true };

test('requested format has explicit token label and rounded utilization', () => {
  assert.equal(tokenBadge(input()), 'tokens: 205K (81%)');
  assert.equal(compose('[existing]', tokenBadge(input())), '[existing] | tokens: 205K (81%)');
});

test('current context is used instead of billed or last-call token totals', () => {
  const data = input();
  data.context_window.total_tokens = 99999999;
  data.context_window.last_call_input_tokens = 123;
  data.context_window.used_percentage = 17;
  data.context_window.context_window_size = 1000000;
  assert.equal(tokenBadge(data), 'tokens: 205K (81%)');
});

test('zero, sub-thousand and thousand-rounding boundaries are meaningful', () => {
  assert.equal(tokenBadge(input(0, 100000)), 'tokens: 0 (0%)');
  assert.equal(tokenBadge(input(999, 100000)), 'tokens: 999 (1%)');
  assert.equal(tokenBadge(input(1000, 100000)), 'tokens: 1K (1%)');
  assert.equal(tokenBadge(input(205499, 1000000)), 'tokens: 205K (21%)');
  assert.equal(tokenBadge(input(205500, 1000000)), 'tokens: 206K (21%)');
});

test('overfull context is not hidden by clamping and model/tier limits can change', () => {
  assert.equal(tokenBadge(input(120000, 100000)), 'tokens: 120K (120%)');
  assert.equal(tokenBadge(input(205000, 1000000)), 'tokens: 205K (21%)');
});

for (const data of [null, {}, { context_window: {} }, input(null), input(-1), input(1.5),
  input('205000'), input(Infinity), input(Number.MAX_SAFE_INTEGER + 1), input(1000, 0),
  input(1000, null), input(1000, '253000')]) {
  test(`missing or invalid native counts hide only the badge: ${JSON.stringify(data)}`, () => {
    assert.equal(tokenBadge(data), '');
    assert.equal(renderStatusLine(JSON.stringify(data), config, { run: () => ({ status: 0, stdout: '[existing]' }) }), '[existing]');
  });
}

test('old-only status payload does not masquerade as current native utilization', () => {
  assert.equal(tokenBadge({ context_window: { last_call_input_tokens: 205000, context_window_size: 253000 } }), '');
});

test('previous output and native JSON are preserved, including additional and Unicode fields', () => {
  const data = { ...input(), extra: 'synthetic-\u00e9', context_window: { ...input().context_window, unknown: true } };
  const text = JSON.stringify(data);
  let forwarded;
  const result = renderStatusLine(text, config, { run: (command, args, options) => {
    assert.equal(command, 'synthetic-renderer');
    assert.deepEqual(args, []);
    assert.equal(options.cwd, root);
    forwarded = options.input;
    return { status: 0, stdout: '\u001b[32m[existing]\u001b[0m\nnext line\n' };
  } });
  assert.equal(forwarded, text);
  assert.equal(result, '\u001b[32m[existing]\u001b[0m\nnext line | tokens: 205K (81%)');
});

test('empty/unconfigured prior renderer shows badge without a separator', () => {
  assert.equal(renderStatusLine(JSON.stringify(input()), { previousStatusLine: null, showTokens: true }), 'tokens: 205K (81%)');
  assert.equal(compose('', ''), '');
});

test('disabling badge retains the existing command and output', () => {
  assert.equal(renderStatusLine(JSON.stringify(input()), { ...config, showTokens: false },
    { run: () => ({ status: 0, stdout: '[existing]' }) }), '[existing]');
});

test('malformed input is forwarded to previous renderer but never generates fake tokens', () => {
  const warnings = [];
  assert.equal(renderStatusLine('{invalid', config, {
    warn: code => warnings.push(code),
    run: (_, __, options) => {
      assert.equal(options.input, '{invalid');
      return { status: 0, stdout: '[previous]' };
    },
  }), '[previous]');
  assert.deepEqual(warnings, ['input-invalid']);
});

test('delegate failures and timeout diagnostics never expose command/error contents', () => {
  for (const result of [{ status: 1, stderr: 'synthetic private data' },
    { status: null, error: { code: 'ETIMEDOUT', message: 'synthetic private path' } }]) {
    const warnings = [];
    assert.equal(renderStatusLine(JSON.stringify(input()), config, {
      run: () => result, warn: code => warnings.push(code),
    }), 'tokens: 205K (81%)');
    assert.equal(warnings.length, 1);
    assert.ok(!JSON.stringify(warnings).includes('private'));
  }
});

test('delegate spawn exceptions preserve the native badge and log only a fixed code', () => {
  const warnings = [];
  assert.equal(renderStatusLine(JSON.stringify(input()), config, {
    run: () => { throw new Error('synthetic-private-spawn-message'); },
    warn: code => warnings.push(code),
  }), 'tokens: 205K (81%)');
  assert.deepEqual(warnings, ['previous-command-error']);
});

test('command substitution supports the same documented home/environment forms', () => {
  assert.equal(expandCommand('node "$HOME\\render.mjs" ${BIN} ${ABSENT:-fallback}', { HOME: 'C:\\home', BIN: 'x' }, 'C:\\home'),
    'node "C:\\home\\render.mjs" x fallback');
  assert.equal(expandCommand('~\\render.mjs', {}, 'C:\\home'), 'C:\\home\\render.mjs');
});

test('recursive wrapper is not invoked', () => {
  const warnings = [];
  const command = `"${process.execPath}" "${join(root, 'statusline', 'statusline.mjs')}"`;
  assert.equal(renderPrevious(command, '{}', {}, {
    run: () => { throw new Error('recursive command was executed'); }, warn: code => warnings.push(code),
  }), '');
  assert.deepEqual(warnings, ['recursive-command']);
});

for (const value of [null, [], {}, { ...config, showTokens: 'true' }, { ...config, typo: true },
  { ...config, previousStatusLine: { command: 10 } }]) {
  test(`invalid compositor config rejects ${JSON.stringify(value)}`, () => assert.throws(() => validateConfig(value)));
}

test('real child command receives session JSON and outputs composed text from a spaced path', async () => {
  const directory = await mkdtemp(join(run, 'path with spaces-'));
  const previous = join(directory, 'previous-renderer.mjs');
  await writeFile(previous, "let text=''; process.stdin.setEncoding('utf8'); for await(const part of process.stdin) text+=part; const data=JSON.parse(text); process.stdout.write(`[${data.session_id}]`);\n");
  const compositor = join(directory, 'statusline.mjs');
  await copyFile(join(root, 'statusline', 'statusline.mjs'), compositor);
  const command = `"${process.execPath}" "${previous}"`;
  await writeFile(join(directory, 'config.json'), JSON.stringify({ previousStatusLine: { command }, showTokens: true }));
  const result = spawnSync(process.execPath, [compositor], { input: JSON.stringify(input()), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, '[synthetic-session] | tokens: 205K (81%)');
});

test('Windows installer preserves unrelated JSONC settings, padding and refresh configuration', { skip: process.platform !== 'win32' }, async () => {
  const home = await mkdtemp(join(run, 'isolated-home-'));
  const settingsPath = join(home, 'settings.json');
  await writeFile(settingsPath, `{
    // A user comment must survive native settings editing.
    "theme": "dim",
    "statusLine": { "type": "command", "command": "node synthetic-renderer.mjs", "padding": 2, "refreshInterval": 7 },
    "terminalProgress": false
  }\n`);
  const result = spawnSync('pwsh', ['-NoProfile', '-File', join(root, 'scripts', 'install-statusline.ps1'), '-CopilotHome', home],
    { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const saved = JSON.parse(await readFile(join(home, 'statusline', 'context-tokens', 'config.json'), 'utf8'));
  assert.deepEqual(saved.previousStatusLine, { type: 'command', command: 'node synthetic-renderer.mjs', padding: 2, refreshInterval: 7 });
  assert.equal(saved.showTokens, true);
  const raw = await readFile(settingsPath, 'utf8');
  assert.ok(raw.includes('A user comment must survive'));
  const settings = JSON.parse(raw.replace(/\/\/[^\r\n]*/g, ''));
  assert.equal(settings.theme, 'dim');
  assert.equal(settings.terminalProgress, false);
  assert.equal(settings.statusLine.padding, 2);
  assert.equal(settings.statusLine.refreshInterval, 7);
  assert.ok(settings.statusLine.command.includes('context-tokens'));
  const again = spawnSync('pwsh', ['-NoProfile', '-File', join(root, 'scripts', 'install-statusline.ps1'), '-CopilotHome', home],
    { encoding: 'utf8', timeout: 30000 });
  assert.notEqual(again.status, 0);
  assert.equal(await readFile(settingsPath, 'utf8'), raw);
});

for (const original of [
  '{}',
  '{"theme":"dim",}',
  '{"statusLine":null,"theme":"dim"}',
  '{"statusLine":{"padding":2,},"theme":"dim"}',
  '{"statusLine":{/* keep empty group comment */},"theme":"dim"}',
  '{"other":{"statusLine":{"command":"nested"}},"theme":"dim"}',
]) {
  test(`Windows installer handles JSONC group insertion: ${original}`, { skip: process.platform !== 'win32' }, async () => {
    const home = await mkdtemp(join(run, 'settings-insert-'));
    await writeFile(join(home, 'settings.json'), original);
    const result = spawnSync('pwsh', ['-NoProfile', '-File', join(root, 'scripts', 'install-statusline.ps1'), '-CopilotHome', home],
      { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const verify = spawnSync('pwsh', ['-NoProfile', '-Command',
      `$s=Get-Content -LiteralPath '${join(home, 'settings.json').replaceAll("'", "''")}' -Raw | ConvertFrom-Json; $s | ConvertTo-Json -Depth 5 -Compress`],
    { encoding: 'utf8', timeout: 10000 });
    assert.equal(verify.status, 0, verify.stderr);
    const settings = JSON.parse(verify.stdout);
    assert.ok(settings.statusLine.command.includes('context-tokens'));
    assert.equal(settings.theme, original.includes('"theme"') ? 'dim' : undefined);
    if (original.includes('"nested"')) assert.equal(settings.other.statusLine.command, 'nested');
    if (original.includes('padding')) assert.equal(settings.statusLine.padding, 2);
    if (original.includes('comment')) assert.ok((await readFile(join(home, 'settings.json'), 'utf8')).includes('comment'));
  });
}

for (const original of [
  '{"statusLine":{},"statusLine":{}}',
  '{"statusLine":{"command":"first","command":"second"}}',
  '{"statusLine":"invalid"}',
  '{invalid',
]) {
  test(`Windows installer rejects unsafe settings without altering them: ${original}`, { skip: process.platform !== 'win32' }, async () => {
    const home = await mkdtemp(join(run, 'settings-invalid-'));
    const path = join(home, 'settings.json');
    await writeFile(path, original);
    const result = spawnSync('pwsh', ['-NoProfile', '-File', join(root, 'scripts', 'install-statusline.ps1'), '-CopilotHome', home],
      { encoding: 'utf8', timeout: 30000 });
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(path, 'utf8'), original);
  });
}
