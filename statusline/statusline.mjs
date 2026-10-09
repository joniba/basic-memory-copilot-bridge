import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const configPath = join(dirname(script), 'config.json');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const diagnostic = code => process.stderr.write(`context-token-statusline: ${code}\n`);

export function tokenBadge(status) {
  const context = status?.context_window;
  if (!object(context) || !count(context.current_context_tokens)
    || !count(context.displayed_context_limit) || context.displayed_context_limit === 0) return '';
  const tokens = context.current_context_tokens;
  const percentage = Math.round(tokens / context.displayed_context_limit * 100);
  const amount = tokens < 1000 ? String(tokens) : `${Math.round(tokens / 1000)}K`;
  const color = percentage >= 70 ? '\u001b[31m' : percentage >= 60 ? '\u001b[33m' : '';
  const warning = percentage >= 70 ? ' - compaction imminent' : percentage >= 60 ? ' - nearing compaction' : '';
  return `tokens: ${amount} (${color}${percentage}%${warning}${color ? '\u001b[39m' : ''})`;
}

export function compose(previous, badge) {
  const text = previous.trimEnd();
  return text && badge ? `${text} | ${badge}` : text || badge;
}

export function expandCommand(command, env = process.env, home = homedir()) {
  const expanded = command.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_, braced, fallback, plain) => env[braced || plain] || fallback || '');
  return expanded.replace(/^~(?=[\\/]|$)/, home);
}

export function validateConfig(value) {
  if (!object(value) || Object.keys(value).some(key => !['previousStatusLine', 'showTokens'].includes(key))
    || typeof value.showTokens !== 'boolean'
    || !(value.previousStatusLine === null || (object(value.previousStatusLine)
      && typeof value.previousStatusLine.command === 'string'))) throw new Error('config-invalid');
  return value;
}

export function renderPrevious(command, input, status, {
  timeout = 2000, run = spawnSync, env = process.env, home = homedir(), warn = diagnostic,
} = {}) {
  if (!command?.trim()) return '';
  const expanded = expandCommand(command, env, home);
  if (expanded.toLowerCase().replaceAll('/', '\\').includes(script.toLowerCase().replaceAll('/', '\\'))) {
    warn('recursive-command');
    return '';
  }
  let result;
  try {
    result = run(expanded, [], {
      shell: true, windowsHide: true, input, encoding: 'utf8',
      timeout, maxBuffer: 64 * 1024, env,
      ...(typeof status?.cwd === 'string' && isAbsolute(status.cwd) ? { cwd: status.cwd } : {}),
    });
  } catch {
    warn('previous-command-error');
    return '';
  }
  if (result.error || result.status !== 0) {
    warn(result.error?.code === 'ETIMEDOUT' ? 'previous-command-timeout' : 'previous-command-error');
    return '';
  }
  return result.stdout || '';
}

export function renderStatusLine(input, config, options) {
  let status;
  try {
    status = JSON.parse(input);
  } catch {
    (options?.warn || diagnostic)('input-invalid');
  }
  const previous = renderPrevious(config.previousStatusLine?.command, input, status, options);
  return compose(previous, config.showTokens ? tokenBadge(status) : '');
}

async function main() {
  let input = '';
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 1024 * 1024) throw new Error('input-oversized');
    }
  } catch {
    diagnostic('input-read-error');
    return;
  }
  let config;
  try {
    config = validateConfig(JSON.parse(await readFile(configPath, 'utf8')));
  } catch {
    diagnostic('config-read-error');
    return;
  }
  try {
    process.stdout.write(renderStatusLine(input, config));
  } catch {
    diagnostic('render-error');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === script) await main();
