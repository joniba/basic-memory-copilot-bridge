#!/usr/bin/env node
import { readFile, lstat, mkdir, open, rename, realpath, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, relative, sep, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { parseTree, getNodeValue, printParseErrorCode } from 'jsonc-parser';
import { validateConfig as validateBridge } from '../extension/bridge.mjs';
import { validateConfig as validateCompositor, expandCommand } from '../statusline/statusline.mjs';

const script = fileURLToPath(import.meta.url);
const packageRoot = dirname(dirname(script));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const extensionFiles = ['status-publisher.mjs', 'bridge.mjs', 'extension.mjs'];
const compositorFiles = ['contributions.mjs', 'statusline.mjs'];

export function options(args, env = process.env) {
  const { values } = parseArgs({
    args, strict: true,
    options: {
      update: { type: 'boolean' },
      'no-statusline': { type: 'boolean' },
      'statusline-only': { type: 'boolean' },
      'copilot-home': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
    },
  });
  if (values['no-statusline'] && values['statusline-only']) throw new Error('Choose --no-statusline or --statusline-only, not both.');
  const home = values['copilot-home'] ?? (env.COPILOT_HOME || join(homedir(), '.copilot'));
  if (!isAbsolute(home)) throw new Error('Copilot home must be an absolute path.');
  if (resolve(home) === parse(resolve(home)).root) throw new Error('Choose a dedicated Copilot home, not the filesystem root.');
  return {
    home: resolve(home), extension: !values['statusline-only'], statusline: !values['no-statusline'],
    update: Boolean(values.update), help: Boolean(values.help), version: Boolean(values.version),
  };
}

async function snapshot(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular, non-symlink file: ${path}`);
    return { bytes: await readFile(path), mode: info.mode & 0o777 };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function checkDirectories(home, path) {
  const inside = relative(home, path);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('Install target escaped Copilot home.');
  let current = home;
  for (const part of ['', ...inside.split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Expected a non-symlink installation directory: ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function document(bytes, path, jsonc = false) {
  const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const offset = raw.startsWith('\ufeff') ? 1 : 0;
  const errors = [];
  const tree = parseTree(raw.slice(offset), errors, { allowTrailingComma: jsonc, disallowComments: !jsonc });
  if (errors.length || tree?.type !== 'object') {
    throw new Error(`Invalid ${jsonc ? 'JSONC' : 'JSON'} object: ${path}${errors.length ? ` (${printParseErrorCode(errors[0].error)})` : ''}`);
  }
  return { raw, offset, tree, value: getNodeValue(tree) };
}

function property(node, name) {
  const found = node.children.filter(child => child.children[0].value === name);
  if (found.length > 1) throw new Error(`Duplicate managed settings property: ${name}`);
  return found[0]?.children[1];
}

export function patchSettings(bytes, command) {
  const doc = document(bytes, 'settings.json', true);
  const group = property(doc.tree, 'statusLine');
  const encoded = JSON.stringify(command);
  let updated = doc.raw;
  if (!group) {
    const start = doc.tree.offset + doc.offset + 1;
    const newline = doc.raw.includes('\r\n') ? '\r\n' : '\n';
    updated = updated.slice(0, start) + `${newline}  "statusLine":{"command":${encoded},"refreshInterval":2}${doc.tree.children.length ? ',' : ''}`
      + updated.slice(start);
  } else if (group.type === 'null') {
    const start = group.offset + doc.offset;
    updated = updated.slice(0, start) + `{"command":${encoded},"refreshInterval":2}` + updated.slice(start + group.length);
  } else {
    if (group.type !== 'object') throw new Error('statusLine must be an object or null.');
    const current = property(group, 'command');
    const refresh = property(group, 'refreshInterval');
    const type = property(group, 'type');
    if (type && type.type !== 'null' && type.value !== 'command') throw new Error('Existing statusLine.type must be command or unset.');
    if (current && !['string', 'null'].includes(current.type)) throw new Error('Existing status-line command must be a string or null.');
    if (refresh && refresh.type !== 'null'
      && (!Number.isInteger(refresh.value) || refresh.value < 1 || refresh.value > 2147483)) {
      throw new Error('Existing status-line refreshInterval is invalid; settings left unchanged.');
    }
    const edits = [];
    const additions = [];
    if (!current) additions.push(`"command":${encoded}`);
    else if (current.value !== command) edits.push({ start: current.offset + doc.offset, length: current.length, text: encoded });
    if (!refresh) additions.push('"refreshInterval":2');
    else if (refresh.type === 'null') edits.push({ start: refresh.offset + doc.offset, length: refresh.length, text: '2' });
    if (additions.length) edits.push({
      start: group.offset + doc.offset + 1, length: 0,
      text: additions.join(',') + (group.children.length ? ',' : ''),
    });
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      updated = updated.slice(0, edit.start) + edit.text + updated.slice(edit.start + edit.length);
    }
  }
  return { bytes: Buffer.from(updated, 'utf8'), settings: doc.value };
}

export function statusCommand(executable, scriptPath, platform = process.platform) {
  if (/[\r\n\0"$%`]/.test(executable + scriptPath)) {
    throw new Error('Status-line installation paths must not contain shell/environment expansion characters.');
  }
  return platform === 'win32' ? `"${executable}" "${scriptPath}"`
    : `'${executable.replaceAll("'", "'\\''")}' '${scriptPath.replaceAll("'", "'\\''")}'`;
}

function normalized(path) {
  const value = resolve(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function ownsCommand(command, scriptPath) {
  if (typeof command !== 'string') return false;
  const quoted = /^"[^"]+"\s+"([^"]+)"\s*$/.exec(command);
  const single = /^'[^']+'\s+'([^']+)'\s*$/.exec(command);
  const simple = /^node(?:\.exe)?\s+"([^"]+)"\s*$/.exec(command);
  const match = quoted ?? single ?? simple;
  return Boolean(match && isAbsolute(expandCommand(match[1]))
    && normalized(expandCommand(match[1])) === normalized(scriptPath));
}

function referencesCompositor(command) {
  return typeof command === 'string' && command.replaceAll('/', '\\').toLowerCase().includes('\\statusline\\context-tokens\\statusline.mjs');
}

export function inspectLegacy(home) {
  const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'copilot plugin list --json'], {
      encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, COPILOT_HOME: home },
    })
    : spawnSync('copilot', ['plugin', 'list', '--json'], {
      encoding: 'utf8', timeout: 30000, env: { ...process.env, COPILOT_HOME: home },
    });
  if (result.error || result.status !== 0) throw new Error('Could not inspect legacy plugins. Run copilot plugin list --json to diagnose.');
  let plugins;
  try { plugins = JSON.parse(result.stdout); }
  catch { throw new Error('Copilot returned an invalid plugin inventory.'); }
  if (!Array.isArray(plugins)) throw new Error('Copilot returned an invalid plugin inventory.');
  if (plugins.some(plugin => plugin.name === 'basic-memory-copilot' && plugin.enabled)) {
    throw new Error('Disable the retired basic-memory-copilot plugin before installing the native extension; no automatic removal is performed.');
  }
}

export async function planInstallation(selection, {
  root = packageRoot, executable = process.execPath, legacy = inspectLegacy,
} = {}) {
  const home = selection.home;
  const extension = join(home, 'extensions', 'basic-memory-bridge');
  const compositor = join(home, 'statusline', 'context-tokens');
  const entries = [];
  const guards = [];
  async function guard(path) {
    const before = await snapshot(path);
    guards.push({ path, before });
    return before;
  }
  async function add(path, bytes) {
    const before = await guard(path);
    if (!before || !before.bytes.equals(bytes)) entries.push({ path, bytes, before, destructive: Boolean(before) });
  }
  if (selection.extension) {
    await checkDirectories(home, extension);
    const source = await snapshot(join(root, 'extension', 'config.json'));
    if (!source) throw new Error('Package is missing extension/config.json.');
    validateBridge(document(source.bytes, 'packaged capture config').value);
    const installed = await guard(join(extension, 'config.json'));
    if (installed) validateBridge(document(installed.bytes, 'installed capture config').value);
    else entries.push({ path: join(extension, 'config.json'), bytes: source.bytes, before: null, destructive: false });
    for (const name of extensionFiles) {
      const source = await snapshot(join(root, 'extension', name));
      if (!source) throw new Error(`Package is missing extension/${name}.`);
      await add(join(extension, name), source.bytes);
    }
  }
  if (selection.statusline) {
    await checkDirectories(home, compositor);
    const path = join(compositor, 'statusline.mjs');
    const command = statusCommand(executable, path);
    const settingsPath = join(home, 'settings.json');
    const beforeSettings = await guard(settingsPath);
    const patched = patchSettings(beforeSettings?.bytes ?? Buffer.from('{}'), command);
    const current = patched.settings.statusLine?.command ?? null;
    const configPath = join(compositor, 'config.json');
    const beforeConfig = await guard(configPath);
    const config = beforeConfig ? validateCompositor(document(beforeConfig.bytes, 'installed compositor config').value) : null;
    const owned = current === command || ownsCommand(current, path);
    if (owned && !config) throw new Error('The compositor is configured but its saved config is missing; recover it before reinstalling.');
    if (!owned && referencesCompositor(current)) throw new Error('The current command references a compositor in an unsupported form/location; restore the original renderer before reinstalling.');
    if (referencesCompositor(config?.previousStatusLine?.command)) throw new Error('Saved previousStatusLine is recursive; inspect it before reinstalling.');
    const previous = owned ? config.previousStatusLine
      : typeof current === 'string' ? patched.settings.statusLine : null;
    const nextConfig = { previousStatusLine: previous, showTokens: config?.showTokens ?? true };
    if (!config || config.previousStatusLine?.command !== previous?.command) {
      entries.push({ path: configPath, bytes: Buffer.from(`${JSON.stringify(nextConfig, null, 2)}\n`), before: beforeConfig, destructive: Boolean(beforeConfig) });
    }
    for (const name of compositorFiles) {
      const source = await snapshot(join(root, 'statusline', name));
      if (!source) throw new Error(`Package is missing statusline/${name}.`);
      await add(join(compositor, name), source.bytes);
    }
    if (!beforeSettings || !beforeSettings.bytes.equals(patched.bytes)) {
      entries.push({
        path: settingsPath, bytes: patched.bytes, before: beforeSettings,
        destructive: typeof current === 'string' && current !== command,
      });
    }
  }
  if (!selection.update && entries.some(entry => entry.destructive)) {
    throw new Error('Existing managed files or status-line wiring would change. Review the selected revision and run again with --update to authorize these scoped changes.');
  }
  if (selection.extension) await legacy(home);
  return { home, entries, guards };
}

async function unchanged(guard) {
  const current = await snapshot(guard.path);
  if (Boolean(current) !== Boolean(guard.before)
    || (current && !current.bytes.equals(guard.before.bytes))) {
    throw new Error(`Concurrent change detected; install stopped without overwriting: ${guard.path}`);
  }
}

async function atomicWrite(path, bytes, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', mode);
  try { await file.writeFile(bytes); }
  finally { await file.close(); }
  try { await rename(temporary, path); }
  catch (error) {
    throw new Error(`Install stopped writing ${path}; staged file retained at ${temporary}. Inspect the partial result before retrying.`, { cause: error });
  }
}

async function applyFiles(plan) {
  for (const guard of plan.guards) await unchanged(guard);
  const existing = plan.entries.filter(entry => entry.before);
  let backup;
  if (existing.length) {
    backup = join(plan.home, 'installation-backups', 'basic-memory-bridge', `${Date.now()}-${randomUUID()}`);
    await checkDirectories(plan.home, dirname(backup));
    for (const entry of existing) {
      const target = join(backup, relative(plan.home, entry.path));
      await mkdir(dirname(target), { recursive: true });
      const file = await open(target, 'wx', 0o600);
      try { await file.writeFile(entry.before.bytes); }
      finally { await file.close(); }
      if (!(await readFile(target)).equals(entry.before.bytes)) throw new Error(`Backup verification failed; no runtime files replaced: ${target}`);
    }
  }
  for (const entry of plan.entries) {
    await checkDirectories(plan.home, dirname(entry.path));
    await unchanged({ path: entry.path, before: entry.before });
    await atomicWrite(entry.path, entry.bytes, entry.before?.mode);
    const actual = await snapshot(entry.path);
    if (!actual?.bytes.equals(entry.bytes)) throw new Error(`Installed file verification failed; preserve the partial result: ${entry.path}`);
  }
  return { filesChanged: plan.entries.length, backup };
}

export async function applyInstallation(plan) {
  if (!plan.entries.length) return applyFiles(plan);
  await checkDirectories(plan.home, plan.home);
  await mkdir(plan.home, { recursive: true });
  const path = join(plan.home, '.basic-memory-bridge-install.lock');
  let lock;
  try { lock = await open(path, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Installation lock already exists; inspect its owner before retrying. No automatic lock removal is performed.');
    throw error;
  }
  const owner = JSON.stringify({ owner: randomUUID(), pid: process.pid, startedAt: new Date().toISOString() });
  try {
    await lock.writeFile(owner);
    return await applyFiles(plan);
  } finally {
    await lock.close();
    const current = await snapshot(path);
    if (!current || current.bytes.toString() !== owner) throw new Error('Installation lock ownership changed; the lock is left untouched.');
    await unlink(path);
  }
}

async function main() {
  const selection = options(process.argv.slice(2));
  if (selection.help) {
    console.log('Usage: basic-memory-copilot-bridge [--update] [--no-statusline | --statusline-only] [--copilot-home PATH]');
    console.log('Installs the native extension and composing status line. --update permits scoped in-place updates, preserving capture config, renderer preferences and runtime state. No deletion or automatic reload.');
    return;
  }
  if (selection.version) {
    console.log(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).version);
    return;
  }
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20 or newer is required.');
  const plan = await planInstallation(selection);
  const result = await applyInstallation(plan);
  console.log(result.filesChanged ? `Installed/updated ${result.filesChanged} managed files under ${plan.home}.` : 'Installed runtime is already current; no managed files or settings changed.');
  if (result.backup) console.log(`Originals preserved at ${result.backup}.`);
  console.log('Capture config, previous renderer preferences, state, MCP and unrelated settings are preserved.');
  if (selection.extension) console.log('Load native code in a new Copilot process, or use an explicitly approved all-extension reload in the owning session.');
  if (selection.statusline) console.log('Existing sessions: /settings statusLine.padding 0 reloads live settings; retain your nonzero padding when applicable. Renderer code updates on refresh.');
}

if (process.argv[1] && normalized(await realpath(process.argv[1])) === normalized(script)) {
  try { await main(); }
  catch (error) {
    console.error(`basic-memory-copilot-bridge: ${error.message}`);
    process.exitCode = 1;
  }
}
