import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, symlink } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse as parseJsonc } from 'jsonc-parser';
import { options, patchSettings, planInstallation, applyInstallation, statusCommand } from '../scripts/install.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(root, '.test-artifacts'), { recursive: true });
const run = await mkdtemp(join(root, '.test-artifacts', 'installation-'));
const extensionNames = ['config.json', 'status-publisher.mjs', 'bridge.mjs', 'extension.mjs'];
const compositorNames = ['config.json', 'contributions.mjs', 'statusline.mjs'];
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const selection = (home, more = {}) => ({ home, extension: true, statusline: true, update: false, ...more });
const dependency = { root, legacy: () => {} };
const extension = home => join(home, 'extensions', 'basic-memory-bridge');
const compositor = home => join(home, 'statusline', 'context-tokens');

async function home(prefix = 'home-') {
  return mkdtemp(join(run, prefix));
}

async function install(target, more = {}, dependencies = dependency) {
  return applyInstallation(await planInstallation(selection(target, more), dependencies));
}

async function managed(target) {
  const files = ['settings.json', ...extensionNames.map(name => join('extensions', 'basic-memory-bridge', name)),
    ...compositorNames.map(name => join('statusline', 'context-tokens', name))];
  return Promise.all(files.map(async name => [name, (await readFile(join(target, name))).toString('base64')]));
}

test('package ships one executable and an explicit runtime/docs allowlist without private data or SDK vendoring', async () => {
  const manifest = await readJson(join(root, 'package.json'));
  assert.deepEqual(manifest.bin, { 'basic-memory-copilot-bridge': 'scripts/install.mjs' });
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, 'module');
  assert.ok(manifest.dependencies['jsonc-parser']);
  assert.ok(manifest.files.includes('extension/status-publisher.mjs'));
  assert.ok(manifest.files.includes('statusline/contributions.mjs'));
  assert.ok(manifest.files.every(path => !/\.local|test-artifacts|node_modules|copilot-sdk/.test(path)));
  const lock = await readJson(join(root, 'package-lock.json'));
  assert.equal(lock.packages['node_modules/jsonc-parser'].version, '3.3.1');
  assert.ok(lock.packages['node_modules/jsonc-parser'].integrity);
  assert.equal(lock.packages['node_modules/jsonc-parser'].resolved, undefined);
});

test('CLI defaults to both components and explicit absolute destination, honoring an empty environment override', () => {
  const target = join(run, 'option-home');
  assert.equal(options([], { COPILOT_HOME: target }).home, target);
  assert.equal(options(['--copilot-home', target, '--update'], {}).update, true);
  assert.equal(options(['--statusline-only'], {}).extension, false);
  assert.equal(options(['--no-statusline'], {}).statusline, false);
  assert.ok(options([], { COPILOT_HOME: '' }).home);
  assert.throws(() => options(['--statusline-only', '--no-statusline'], {}));
  assert.throws(() => options(['--copilot-home', 'relative'], {}));
  assert.throws(() => options(['--copilot-home', parse(root).root], {}));
  assert.throws(() => options(['--force'], {}));
  assert.throws(() => options(['--uninstall'], {}));
});

test('fresh installation copies complete persistent runtime and wires an independent compositor', async () => {
  const target = await home();
  const result = await install(target);
  assert.equal(result.filesChanged, 8);
  assert.equal(result.backup, undefined);
  assert.deepEqual((await readdir(extension(target))).sort(), [...extensionNames].sort());
  assert.deepEqual((await readdir(compositor(target))).sort(), [...compositorNames].sort());
  for (const name of extensionNames) {
    assert.deepEqual(await readFile(join(extension(target), name)), await readFile(join(root, 'extension', name)));
  }
  for (const name of ['contributions.mjs', 'statusline.mjs']) {
    assert.deepEqual(await readFile(join(compositor(target), name)), await readFile(join(root, 'statusline', name)));
  }
  const settings = await readJson(join(target, 'settings.json'));
  assert.equal(settings.statusLine.command, statusCommand(process.execPath, join(compositor(target), 'statusline.mjs')));
  assert.equal(settings.statusLine.refreshInterval, 2);
  assert.ok(!settings.statusLine.command.includes(join(root, 'statusline', 'statusline.mjs')));
  assert.deepEqual(await readJson(join(compositor(target), 'config.json')), { previousStatusLine: null, showTokens: true });
});

test('reinstalling identical files is a byte-preserving no-op and never delegates to itself', async () => {
  const target = await home();
  await install(target);
  const configPath = join(compositor(target), 'config.json');
  const custom = '{ "showTokens": false, "previousStatusLine": null }\n';
  await writeFile(configPath, custom);
  const before = await managed(target);
  const result = await install(target);
  assert.equal(result.filesChanged, 0);
  assert.equal(result.backup, undefined);
  assert.deepEqual(await managed(target), before);
  assert.equal(await readFile(configPath, 'utf8'), custom);
});

test('updates require explicit authorization before any runtime or settings changes', async () => {
  const target = await home();
  await install(target);
  await writeFile(join(extension(target), 'bridge.mjs'), '// old managed code\n');
  const before = await managed(target);
  await assert.rejects(planInstallation(selection(target), dependency), /--update/);
  assert.deepEqual(await managed(target), before);
});

test('authorized update preserves custom capture config, wrapper preferences, state, MCP and unknown files', async () => {
  const target = await home();
  await install(target);
  const bridgeConfig = await readJson(join(extension(target), 'config.json'));
  bridgeConfig.periodicMinimumNewTokens = 71234;
  bridgeConfig.minimumMinutesBetweenOpportunities = 123;
  bridgeConfig.debugLogging = false;
  const configText = ` ${JSON.stringify(bridgeConfig)}\n`;
  await writeFile(join(extension(target), 'config.json'), configText);
  const wrapperText = '{"showTokens":false,"previousStatusLine":null}\n';
  await writeFile(join(compositor(target), 'config.json'), wrapperText);
  const stateDirectory = join(target, 'extension-state', 'basic-memory-bridge', 'sessions');
  await mkdir(stateDirectory, { recursive: true });
  const statePath = join(stateDirectory, 'synthetic-session.json');
  const stateText = '{"lastOpportunityAt":123,"lastOpportunityTokens":456}\n';
  await writeFile(statePath, stateText);
  await writeFile(join(target, 'mcp-config.json'), '{"mcpServers":{}}\n');
  await writeFile(join(extension(target), 'local-preference.txt'), 'do not remove\n');
  const settingsText = await readFile(join(target, 'settings.json'), 'utf8');
  await writeFile(join(extension(target), 'bridge.mjs'), '// previous revision\n');
  const result = await install(target, { update: true });
  assert.equal(result.filesChanged, 1);
  assert.ok(result.backup);
  assert.equal(await readFile(join(result.backup, 'extensions', 'basic-memory-bridge', 'bridge.mjs'), 'utf8'), '// previous revision\n');
  assert.deepEqual(await readFile(join(extension(target), 'bridge.mjs')), await readFile(join(root, 'extension', 'bridge.mjs')));
  assert.equal(await readFile(join(extension(target), 'config.json'), 'utf8'), configText);
  assert.equal(await readFile(join(compositor(target), 'config.json'), 'utf8'), wrapperText);
  assert.equal(await readFile(statePath, 'utf8'), stateText);
  assert.equal(await readFile(join(target, 'mcp-config.json'), 'utf8'), '{"mcpServers":{}}\n');
  assert.equal(await readFile(join(extension(target), 'local-preference.txt'), 'utf8'), 'do not remove\n');
  assert.equal(await readFile(join(target, 'settings.json'), 'utf8'), settingsText);
});

test('newly wrapping an existing trusted renderer requires authorization and preserves JSONC bytes and original command', async () => {
  const target = await home();
  const original = '{\r\n  // Keep comments and spacing.\r\n  "theme": "dim",\r\n  "statusLine": {"command":"node previous.mjs","padding":3,"refreshInterval":7},\r\n  "terminalProgress": false\r\n}\r\n';
  await writeFile(join(target, 'settings.json'), original);
  await assert.rejects(planInstallation(selection(target), dependency), /--update/);
  assert.equal(await readFile(join(target, 'settings.json'), 'utf8'), original);
  assert.deepEqual(await readdir(target), ['settings.json']);
  await install(target, { update: true });
  const raw = await readFile(join(target, 'settings.json'), 'utf8');
  const wrapper = await readJson(join(compositor(target), 'config.json'));
  assert.deepEqual(wrapper.previousStatusLine, { command: 'node previous.mjs', padding: 3, refreshInterval: 7 });
  assert.equal(raw, original.replace('"node previous.mjs"', JSON.stringify(statusCommand(process.execPath, join(compositor(target), 'statusline.mjs')))));
  const before = await managed(target);
  assert.equal((await install(target)).filesChanged, 0);
  assert.deepEqual(await managed(target), before);
});

test('changing the Node interpreter refreshes the owned command but preserves the original delegated renderer', async () => {
  const target = await home();
  await writeFile(join(target, 'settings.json'), '{"statusLine":{"command":"node original.mjs"}}');
  await install(target, { update: true });
  const configBytes = await readFile(join(compositor(target), 'config.json'));
  const executable = join(run, 'different node', process.platform === 'win32' ? 'node.exe' : 'node');
  const result = await install(target, { update: true }, { ...dependency, executable });
  assert.equal(result.filesChanged, 1);
  assert.deepEqual(await readFile(join(compositor(target), 'config.json')), configBytes);
  assert.equal((await readJson(join(target, 'settings.json'))).statusLine.command,
    statusCommand(executable, join(compositor(target), 'statusline.mjs')));
});

test('a user-selected replacement renderer is composed once while keeping showTokens preference and backing up originals', async () => {
  const target = await home();
  await install(target);
  const configPath = join(compositor(target), 'config.json');
  await writeFile(configPath, '{"previousStatusLine":null,"showTokens":false}\n');
  await writeFile(join(target, 'settings.json'), '{"statusLine":{"command":"node replacement.mjs","padding":5,"refreshInterval":9}}');
  await install(target, { update: true });
  const wrapper = await readJson(configPath);
  assert.equal(wrapper.showTokens, false);
  assert.deepEqual(wrapper.previousStatusLine, { command: 'node replacement.mjs', padding: 5, refreshInterval: 9 });
  assert.equal((await install(target)).filesChanged, 0);
});

test('--no-statusline does not read or rewrite an unrelated status configuration', async () => {
  const target = await home();
  const settings = 'not JSON; extension-only installation must not touch this\n';
  await writeFile(join(target, 'settings.json'), settings);
  await install(target, { statusline: false });
  assert.equal(await readFile(join(target, 'settings.json'), 'utf8'), settings);
  assert.deepEqual((await readdir(target)).sort(), ['extensions', 'settings.json']);
});

test('--statusline-only remains independent of the native extension and legacy-plugin inventory', async () => {
  const target = await home();
  await install(target, { extension: false }, { root, legacy: () => { throw new Error('must not inspect'); } });
  assert.deepEqual((await readdir(target)).sort(), ['settings.json', 'statusline']);
});

test('preflight rejects invalid settings before copying either component', async () => {
  const target = await home();
  await writeFile(join(target, 'settings.json'), '{"statusLine":{"command":42}}');
  await assert.rejects(planInstallation(selection(target, { update: true }), dependency), /command/);
  assert.deepEqual(await readdir(target), ['settings.json']);
});

test('preflight rejects invalid preserved capture configuration rather than replacing it with defaults', async () => {
  const target = await home();
  await install(target);
  await writeFile(join(extension(target), 'config.json'), '{"enabled":"wrong"}');
  const before = await managed(target);
  await assert.rejects(planInstallation(selection(target, { update: true }), dependency), /config-invalid/);
  assert.deepEqual(await managed(target), before);
});

test('configured compositor without saved original settings fails instead of nesting itself', async () => {
  const target = await home();
  const command = statusCommand(process.execPath, join(compositor(target), 'statusline.mjs'));
  await writeFile(join(target, 'settings.json'), JSON.stringify({ statusLine: { command } }));
  await assert.rejects(planInstallation(selection(target, { update: true }), dependency), /saved config is missing/);
  assert.deepEqual(await readdir(target), ['settings.json']);
});

test('a recursive saved previous renderer fails before altering anything', async () => {
  const target = await home();
  await install(target);
  const command = (await readJson(join(target, 'settings.json'))).statusLine.command;
  await writeFile(join(compositor(target), 'config.json'), JSON.stringify({ showTokens: true, previousStatusLine: { command } }));
  const before = await managed(target);
  await assert.rejects(planInstallation(selection(target, { update: true }), dependency), /recursive/);
  assert.deepEqual(await managed(target), before);
});

test('legacy guard runs against the selected home and refusal leaves the target unmodified', async () => {
  const target = await home();
  await assert.rejects(planInstallation(selection(target), { root, legacy: selected => {
    assert.equal(selected, target);
    throw new Error('legacy enabled');
  } }), /legacy enabled/);
  assert.deepEqual(await readdir(target), []);
});

test('settings changed after preflight are never overwritten', async () => {
  const target = await home();
  await writeFile(join(target, 'settings.json'), '{}');
  const plan = await planInstallation(selection(target), dependency);
  await writeFile(join(target, 'settings.json'), '{"userChanged":true}');
  await assert.rejects(applyInstallation(plan), /Concurrent change/);
  assert.equal(await readFile(join(target, 'settings.json'), 'utf8'), '{"userChanged":true}');
  assert.deepEqual(await readdir(target), ['settings.json']);
});

test('capture config changed after preflight prevents a managed code update', async () => {
  const target = await home();
  await install(target);
  await writeFile(join(extension(target), 'bridge.mjs'), '// old\n');
  const plan = await planInstallation(selection(target, { update: true }), dependency);
  const config = await readJson(join(extension(target), 'config.json'));
  config.enabled = false;
  await writeFile(join(extension(target), 'config.json'), JSON.stringify(config));
  await assert.rejects(applyInstallation(plan), /Concurrent change/);
  assert.equal(await readFile(join(extension(target), 'bridge.mjs'), 'utf8'), '// old\n');
});

test('an existing installation lock fails closed without deleting or stealing it', async () => {
  const target = await home();
  const plan = await planInstallation(selection(target), dependency);
  const path = join(target, '.basic-memory-bridge-install.lock');
  const original = '{"pid":123456,"startedAt":"synthetic"}\n';
  await writeFile(path, original);
  await assert.rejects(applyInstallation(plan), /Installation lock already exists/);
  assert.equal(await readFile(path, 'utf8'), original);
  assert.deepEqual(await readdir(target), ['.basic-memory-bridge-install.lock']);
});

test('managed directory junctions/symlinks cannot redirect writes outside the selected home', async () => {
  const target = await home();
  const outside = await home('outside-');
  await symlink(outside, join(target, 'extensions'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(planInstallation(selection(target), dependency), /non-symlink/);
  assert.deepEqual(await readdir(outside), []);
});

for (const original of ['{}', '{"theme":"dim",}', '{"statusLine":null}', '{"statusLine":{"padding":2,}}',
  '{"statusLine":{"refreshInterval":null}}', '{"statusLine":{/* retained */}}',
  '{"other":{"statusLine":{"command":"nested"}}}']) {
  test(`JSONC patch inserts exactly the intended status properties: ${original}`, () => {
    const command = 'node synthetic.mjs';
    const patched = patchSettings(Buffer.from(original), command);
    const errors = [];
    const value = parseJsonc(patched.bytes.toString(), errors, { allowTrailingComma: true });
    assert.equal(errors.length, 0);
    assert.equal(value.statusLine.command, command);
    assert.equal(value.statusLine.refreshInterval, 2);
    assert.equal(value.theme, original.includes('dim') ? 'dim' : undefined);
    if (original.includes('padding')) assert.equal(value.statusLine.padding, 2);
    if (original.includes('retained')) assert.ok(patched.bytes.toString().includes('retained'));
    if (original.includes('nested')) assert.equal(value.other.statusLine.command, 'nested');
  });
}

test('UTF-8 BOM, Unicode, comments and unknown settings bytes survive surgical edits', () => {
  const original = '\ufeff{\r\n // caf\u00e9 \ud83c\udf31\r\n "statusLine":{"command":"old","refreshInterval":null},\r\n "unknown": "\u00e9"\r\n}\r\n';
  const patched = patchSettings(Buffer.from(original), 'new');
  assert.equal(patched.bytes.toString(), original.replace('"old"', '"new"').replace(':null', ':2'));
});

for (const original of ['{"statusLine":{},"statusLine":{}}',
  '{"statusLine":{"command":"a","command":"b"}}', '{"statusLine":{"refreshInterval":null,"refreshInterval":2}}',
  '{"statusLine":{"refreshInterval":0}}', '{"statusLine":{"refreshInterval":"2"}}',
  '{"statusLine":{"type":"wrong"}}', '{"statusLine":"wrong"}', '[]', '{bad']) {
  test(`JSONC patch refuses unsafe settings: ${original}`, () => {
    assert.throws(() => patchSettings(Buffer.from(original), 'new'));
  });
}

test('status command uses persistent quoted paths and rejects environment-expansion ambiguity', () => {
  assert.equal(statusCommand('C:\\Program Files\\node\\node.exe', 'C:\\test home\\statusline.mjs', 'win32'),
    '"C:\\Program Files\\node\\node.exe" "C:\\test home\\statusline.mjs"');
  assert.equal(statusCommand('/usr/bin/node', "/home/it's/statusline.mjs", 'linux'),
    "'/usr/bin/node' '/home/it'\\''s/statusline.mjs'");
  assert.throws(() => statusCommand('node', 'C:\\bad$VAR\\statusline.mjs'));
});
