import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const validName = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 160
  && !/[\x00-\x1f\x7f]/.test(value);

export function validContribution(value) {
  if (!object(value) || !['activity', 'hint'].includes(value.kind)
    || !['white', 'yellow', 'red'].includes(value.color)
    || !count(value.priority) || value.priority > 100) return false;
  if (value.kind === 'activity') return text(value.label)
    && (value.prefix === undefined || text(value.prefix));
  return Array.isArray(value.targets) && value.targets.length > 0 && value.targets.length <= 8
    && value.targets.every(target => object(target) && count(target.tokens) && count(target.notBefore))
    && object(value.labels) && ['tokens', 'time', 'ready'].every(key => text(value.labels[key]))
    && (value.tokenCeiling === undefined
      || (count(value.tokenCeiling) && value.tokenCeiling > 0 && text(value.labels.beyond)));
}

export async function readContributions(directory, sessionId, {
  now = Date.now(), warn = () => {},
} = {}) {
  if (!validName(sessionId)) return [];
  const root = join(directory, sessionId);
  let files;
  try {
    files = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') warn('contribution-read-error');
    return [];
  }
  const result = [];
  for (const file of files.filter(file => file.isFile() && /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(file.name))
    .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 32)) {
    try {
      const path = join(root, file.name);
      const info = await lstat(path);
      if (info.isSymbolicLink() || info.size > 16384) throw new Error('invalid-status-file');
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (!object(value) || value.version !== 1 || value.sessionId !== sessionId
        || !count(value.expiresAt) || value.expiresAt > now + 120000 || !validContribution(value.contribution)) {
        if (object(value) && value.contribution === null) continue;
        throw new Error('invalid-status-record');
      }
      if (value.expiresAt > now) result.push(value.contribution);
    } catch (error) {
      if (error.code !== 'ENOENT') warn('contribution-invalid');
    }
  }
  return result.sort((a, b) => b.priority - a.priority);
}

export function contributionLabel(contribution, tokens, now) {
  if (!validContribution(contribution)) return null;
  if (contribution.kind === 'activity') return {
    text: contribution.label, color: contribution.color,
    ...(contribution.prefix === undefined ? {} : { prefix: contribution.prefix }),
  };
  if (!count(tokens)) return null;
  const targets = contribution.targets.filter(target => contribution.tokenCeiling === undefined
    || target.tokens < contribution.tokenCeiling || tokens >= target.tokens);
  if (!targets.length) return { text: contribution.labels.beyond, color: contribution.color };
  const reached = targets.filter(target => tokens >= target.tokens);
  let label;
  if (reached.length) {
    const nextTime = Math.min(...reached.map(target => target.notBefore));
    const target = Math.min(...reached.filter(target => target.notBefore === nextTime).map(target => target.tokens));
    const amount = target < 1000 ? String(target) : `${Math.ceil(target / 1000)}K`;
    label = nextTime > now
      ? contribution.tokenCeiling !== undefined && tokens >= contribution.tokenCeiling
        ? contribution.labels.beyond
        : contribution.labels.time.replaceAll('{minutes}', String(Math.ceil((nextTime - now) / 60000)))
      : contribution.labels.ready.replaceAll('{tokens}', amount);
  } else {
    const target = Math.min(...targets.map(target => target.tokens));
    const amount = target < 1000 ? String(target) : `${Math.ceil(target / 1000)}K`;
    label = contribution.labels.tokens.replaceAll('{tokens}', amount);
  }
  return { text: label, color: contribution.color };
}
