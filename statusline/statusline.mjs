import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contributionLabel, readContributions, validContribution } from './contributions.mjs';

const script = fileURLToPath(import.meta.url);
const configPath = join(dirname(script), 'config.json');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const diagnostic = code => process.stderr.write(`context-token-statusline: ${code}\n`);

const paint = (text, color) => `${{ white: '\u001b[37m', yellow: '\u001b[33m', red: '\u001b[31m' }[color]}${text}\u001b[39m`;
const paintLabel = label => `${label.prefix ? paint(label.prefix, 'white') : ''}${paint(label.text, label.color)}`;

export function tokenBadge(status, contributions = [], now = Date.now()) {
  const candidates = contributions.filter(validContribution).sort((a, b) => b.priority - a.priority);
  const activity = candidates.find(value => value.kind === 'activity');
  const activeLabel = activity ? contributionLabel(activity, null, now) : null;
  const context = status?.context_window;
  if (!object(context) || !count(context.current_context_tokens)
    || !count(context.displayed_context_limit) || context.displayed_context_limit === 0) {
    return activeLabel ? paintLabel(activeLabel) : '';
  }
  const tokens = context.current_context_tokens;
  const percentage = Math.round(tokens / context.displayed_context_limit * 100);
  const amount = tokens < 1000 ? String(tokens) : `${Math.round(tokens / 1000)}K`;
  const color = percentage >= 70 ? 'red' : percentage >= 60 ? 'yellow' : 'white';
  const hint = candidates.find(value => value.kind === 'hint');
  const warning = percentage >= 70 ? 'compaction imminent' : percentage >= 60 ? 'nearing compaction' : null;
  const utilization = `${percentage}%${warning ? ` \u2014 ${warning}` : ''}`;
  const label = activeLabel ?? (hint ? contributionLabel(hint, tokens, now) : null);
  return `tokens: ${amount} (${paint(utilization, color)})${label ? ` ${paintLabel(label)}` : ''}`;
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
  return compose(previous, config.showTokens ? tokenBadge(status, options?.contributions, options?.now) : '');
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
    let contributions = [];
    try {
      const status = JSON.parse(input);
      const home = process.env.COPILOT_HOME || join(homedir(), '.copilot');
      contributions = await readContributions(join(home, 'statusline', 'contributions'), status?.session_id, { warn: diagnostic });
    } catch {
      diagnostic('contribution-input-invalid');
    }
    process.stdout.write(renderStatusLine(input, config, { contributions }));
  } catch {
    diagnostic('render-error');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === script) await main();
