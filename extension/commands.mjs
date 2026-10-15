import { randomUUID } from 'node:crypto';
import * as files from 'node:fs/promises';
import { validateConfig, bounded } from './bridge.mjs';

const usage = 'Usage: /bm-bridge interval <positive integer in K tokens>; for example, /bm-bridge interval 100.';
const codes = new Set(['EACCES', 'EPERM', 'EBUSY', 'EEXIST', 'ENOENT', 'ENOSPC', 'EIO', 'ENOTDIR', 'EISDIR']);

export function parseCommand(args) {
  if (typeof args !== 'string') throw new Error(usage);
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (!parts.length || (parts.length === 1 && ['help', 'interval'].includes(parts[0]))) return null;
  if (parts.length !== 2 || parts[0] !== 'interval' || !/^\d+$/.test(parts[1])) throw new Error(usage);
  const tokens = Number(parts[1]) * 1000;
  if (!Number.isSafeInteger(tokens) || tokens <= 0) throw new Error(usage);
  return tokens;
}

export async function writeInterval(path, tokens, io = files) {
  if (!Number.isSafeInteger(tokens) || tokens <= 0 || tokens % 1000 !== 0) throw new Error(usage);
  const lockPath = `${path}.lock`;
  const owner = JSON.stringify({ owner: randomUUID(), pid: process.pid });
  let lock;
  let result;
  let failure;
  let committed = false;
  let stage = 'lock';
  const failed = cause => {
    const error = new Error('interval-update-failed');
    error.stage = stage;
    error.code = codes.has(cause?.code) ? cause.code : 'UNKNOWN';
    error.committed = committed;
    return error;
  };
  try {
    lock = await io.open(lockPath, 'wx', 0o600);
    await lock.writeFile(owner);
    stage = 'read';
    const info = await io.lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('config-not-regular');
    const before = await io.readFile(path);
    stage = 'validate';
    const raw = JSON.parse(before.toString('utf8'));
    const previous = validateConfig(raw);
    const next = validateConfig({ ...raw, periodicMinimumNewTokens: tokens });
    result = { previous, config: next, changed: raw.periodicMinimumNewTokens !== tokens };
    if (result.changed) {
      const newline = before.includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
      const bytes = Buffer.from(`${JSON.stringify({ ...raw, periodicMinimumNewTokens: tokens }, null, 2).replaceAll('\n', newline)}${newline}`);
      const temporary = `${path}.${randomUUID()}.tmp`;
      stage = 'stage';
      await io.writeFile(temporary, bytes, { flag: 'wx', mode: info.mode & 0o777 });
      stage = 'concurrent-change';
      if (!(await io.readFile(path)).equals(before)) throw new Error('config-changed');
      stage = 'replace';
      await io.rename(temporary, path);
      committed = true;
    }
  } catch (error) {
    failure = failed(error);
  } finally {
    if (lock) {
      stage = 'lock-release';
      try {
        await lock.close();
        if ((await io.readFile(lockPath, 'utf8')) !== owner) throw new Error('lock-owner-changed');
        await io.unlink(lockPath);
      } catch (error) {
        failure ??= failed(error);
      }
    }
  }
  if (failure) throw failure;
  return result;
}

function failureMessage(error) {
  if (error.committed) return 'Interval was saved, but configuration-lock cleanup failed. Inspect the lock before retrying.';
  if (error.stage === 'lock' && error.code === 'EEXIST') return 'Configuration is locked by another writer. Interval was not changed; no lock was removed.';
  if (error.stage === 'validate') return 'The installed bridge configuration is invalid. Interval was not changed.';
  if (error.stage === 'concurrent-change') return 'Configuration changed during the command. The competing edit was preserved; interval was not saved.';
  if (error.stage === 'replace') return `Could not replace configuration (${error.code}). The previous configuration and staged update were preserved.`;
  return `Interval update failed (${error.code ?? 'UNKNOWN'}). No successful change is being reported.`;
}

export function bridgeCommand(path, getBridge) {
  return {
    name: 'bm-bridge',
    description: 'Show or change the machine-wide memory checkpoint interval in K tokens.',
    handler: async context => {
      const bridge = getBridge();
      if (!bridge) throw new Error('Basic Memory bridge is still attaching. Try /bm-bridge again shortly.');
      if (context.sessionId !== bridge.session.sessionId) throw new Error('Basic Memory command session does not match its registered session.');
      let saved = false;
      const notify = async (message, level = 'info') => {
        try {
          await bounded(bridge.session.log(`[basic-memory-bridge] ${message}`, { level }));
        } catch {
          console.error('{"event":"command","gateDecision":"notice-error"}');
          throw new Error(saved ? 'Interval was saved, but command confirmation could not be displayed.'
            : 'Basic Memory command output could not be displayed.');
        }
      };
      let tokens;
      try {
        tokens = parseCommand(context.args);
      } catch {
        await notify(usage, 'warning');
        return;
      }
      if (tokens === null) {
        let config;
        try {
          config = validateConfig(JSON.parse(await files.readFile(path, 'utf8')));
        } catch {
          await notify('The installed bridge configuration could not be read or is invalid.', 'warning');
          return;
        }
        await notify(`Machine-wide periodic interval: ${config.periodicMinimumNewTokens / 1000}K tokens; minimum time: ${config.minimumMinutesBetweenOpportunities}m. Pressure rules are independent. ${usage}`);
        return;
      }
      let result;
      try {
        result = await writeInterval(path, tokens);
      } catch (error) {
        saved = error.committed === true;
        await notify(failureMessage(error), 'warning');
        if (error.committed) await bridge.refreshConfiguration();
        return;
      }
      saved = result.changed;
      await bridge.refreshConfiguration();
      await notify(`Machine-wide periodic interval ${result.changed ? 'set to' : 'is already'} ${tokens / 1000}K tokens. Time and pressure rules, checkpoint history and accepted requests are unchanged. Other sessions adopt this on their next native event.`);
    },
  };
}
