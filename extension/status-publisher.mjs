import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const validName = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
const operations = new Set(['mkdir', 'lock-acquire', 'read-owner', 'write-temp', 'replace',
  'temp-cleanup', 'lock-close', 'lock-release', 'encode']);
const errorCodes = new Set(['EACCES', 'EPERM', 'EBUSY', 'EEXIST', 'EADDRINUSE', 'ENOENT', 'ENOSPC',
  'EIO', 'EMFILE', 'ENFILE', 'EROFS', 'ENOTDIR', 'EISDIR', 'EINVAL', 'EXDEV', 'INVALID', 'LIMIT']);
const retryDelays = [25, 50, 100, 200, 400];
const windowsSharingCodes = new Set(['EPERM', 'EACCES', 'EBUSY']);
const sharingOperations = new Set(['read-owner', 'replace', 'temp-cleanup', 'lock-release']);

export function publicationDiagnostic(error) {
  return {
    event: 'status-contribution',
    operation: operations.has(error?.operation) ? error.operation : 'unknown',
    code: errorCodes.has(error?.code) ? error.code : 'UNKNOWN',
    decision: error?.recovered === true ? 'recovered' : 'failed',
    attempts: Number.isInteger(error?.attempts) && error.attempts >= 1
      && error.attempts <= retryDelays.length + 1 ? error.attempts : 1,
  };
}

async function fileOperation(operation, action, report, trace, context) {
  let lastCode;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = trace ? await trace(`status.${operation}`, action, context) : await action();
      if (attempt) report({ operation, code: lastCode, recovered: true, attempts: attempt + 1 });
      return result;
    } catch (cause) {
      lastCode = errorCodes.has(cause?.code) ? cause.code : 'UNKNOWN';
      const retryable = operation === 'lock-acquire' && ['EEXIST', 'EADDRINUSE'].includes(lastCode)
        || process.platform === 'win32' && sharingOperations.has(operation)
          && windowsSharingCodes.has(lastCode);
      if (retryable && attempt < retryDelays.length) {
        await delay(retryDelays[attempt]);
        continue;
      }
      const error = new Error('status-publication-error', { cause });
      error.operation = operation;
      error.code = lastCode;
      error.attempts = attempt + 1;
      throw error;
    }
  }
}

function selectContribution(contribution) {
  return contribution ? {
    kind: contribution.kind, color: contribution.color, priority: contribution.priority,
    ...(contribution.kind === 'activity' ? {
      label: contribution.label,
      ...(contribution.prefix === undefined ? {} : { prefix: contribution.prefix }),
    } : {
      targets: contribution.targets.map(target => ({ tokens: target.tokens, notBefore: target.notBefore })),
      ...(contribution.tokenCeiling === undefined ? {} : { tokenCeiling: contribution.tokenCeiling }),
      labels: {
        tokens: contribution.labels.tokens, time: contribution.labels.time, ready: contribution.labels.ready,
        ...(contribution.tokenCeiling === undefined ? {} : { beyond: contribution.labels.beyond }),
      },
    }),
  } : null;
}

export class StatusPublisher {
  constructor(directory, sessionId, provider, {
    clock = Date.now, lifetime = 30000, renewInterval = 10000,
    report = error => console.error(JSON.stringify(publicationDiagnostic(error))),
    trace, context = () => ({}), transition = () => {},
  } = {}) {
    if (!validName(sessionId) || !validName(provider)) throw new Error('status-identity-invalid');
    if (!Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > 120000
      || !Number.isSafeInteger(renewInterval) || renewInterval < 1 || renewInterval >= lifetime) {
      throw new Error('status-lifetime-invalid');
    }
    this.directory = join(directory, sessionId);
    this.path = join(this.directory, `${provider}.json`);
    this.sessionId = sessionId;
    this.owner = randomUUID();
    this.clock = clock;
    this.lifetime = lifetime;
    this.current = null;
    this.claimed = false;
    this.expectedOwner = undefined;
    this.closed = false;
    this.queue = Promise.resolve();
    this.report = report;
    this.operation = (operation, action) => fileOperation(operation, action, this.report, trace,
      trace ? context() : undefined);
    this.transition = transition;
    this.transitionFailures = 0;
    this.timer = setInterval(() => {
      if (this.current && !this.closed) this.renew();
    }, renewInterval);
    this.timer.unref();
  }

  publish(contribution) {
    return this.enqueue(() => {
      this.current = null;
      try {
        this.current = selectContribution(contribution);
      } catch (cause) {
        const error = new Error('status-publication-error', { cause });
        error.operation = 'encode';
        error.code = 'INVALID';
        throw error;
      }
      return this.write(this.current);
    });
  }

  signal(record) {
    const failed = () => {
      this.transitionFailures = Math.min(this.transitionFailures + 1, Number.MAX_SAFE_INTEGER);
      try {
        console.error('{"event":"status-contribution","gateDecision":"diagnostic-error"}');
      } catch {
        this.transitionFailures = Math.min(this.transitionFailures + 1, Number.MAX_SAFE_INTEGER);
      }
    };
    try {
      const submitted = this.transition(record);
      if (typeof submitted?.then === 'function') Promise.resolve(submitted).catch(failed);
    } catch {
      failed();
    }
  }

  renew() {
    return this.enqueue(() => this.write(this.current));
  }

  enqueue(write) {
    const action = this.queue.then(write);
    this.queue = action.catch(this.report);
    return action;
  }

  async acquireLock() {
    if (process.platform !== 'win32') return open(`${this.path}.lock`, 'wx');
    const key = createHash('sha256').update(join(await realpath(this.directory), basename(this.path)).toLowerCase()).digest('hex');
    const pipe = `\\\\.\\pipe\\copilot-status-lock-${key}`;
    const server = createServer(socket => socket.destroy());
    return new Promise((resolve, reject) => {
      const failed = error => {
        server.removeListener('listening', ready);
        reject(error);
      };
      const ready = () => {
        server.removeListener('error', failed);
        server.on('error', error => this.report({ operation: 'lock-acquire', code: error.code }));
        server.unref();
        resolve({
          close: () => new Promise((done, failedClose) =>
            server.close(error => error ? failedClose(error) : done())),
        });
      };
      server.once('error', failed);
      server.once('listening', ready);
      server.listen(pipe);
    });
  }

  async write(contribution) {
    if (this.closed) return;
    await this.operation('mkdir', () => mkdir(this.directory, { recursive: true }));
    if (!this.claimed && this.expectedOwner === undefined) {
      const previous = await this.readRecord();
      this.expectedOwner = typeof previous?.owner === 'string' ? previous.owner : null;
    }
    const lockPath = `${this.path}.lock`;
    const lock = await this.operation('lock-acquire', () => this.acquireLock());
    let temporary;
    try {
      const previous = await this.readRecord();
      const owner = typeof previous?.owner === 'string' ? previous.owner : null;
      if (this.claimed ? previous && owner !== this.owner : owner !== this.expectedOwner) {
        this.closed = true;
        clearInterval(this.timer);
        this.signal({ gateDecision: 'owner-changed' });
        return;
      }
      const now = this.clock();
      const value = contribution;
      const record = {
        version: 1, sessionId: this.sessionId, owner: this.owner,
        expiresAt: value ? now + this.lifetime : now, contribution: value,
      };
      const content = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(content) > 16384) {
        this.current = null;
        const error = new Error('status-publication-error');
        error.operation = 'encode';
        error.code = 'LIMIT';
        throw error;
      }
      temporary = `${this.path}.${randomUUID()}.tmp`;
      await this.operation('write-temp', () => writeFile(temporary, content, { flag: 'wx', mode: 0o600 }));
      await this.operation('replace', () => rename(temporary, this.path));
      temporary = null;
      this.claimed = true;
    } finally {
      try {
        if (temporary) await this.operation('temp-cleanup', () => unlink(temporary));
      } finally {
        await this.operation('lock-close', () => lock.close());
        if (process.platform !== 'win32') {
          await this.operation('lock-release', () => unlink(lockPath));
        }
      }
    }
  }

  async readRecord() {
    try {
      const record = JSON.parse(await this.operation('read-owner', () => readFile(this.path, 'utf8')));
      if (record?.version !== 1 || record?.sessionId !== this.sessionId || !Number.isSafeInteger(record?.expiresAt)) {
        this.signal({ gateDecision: 'owner-record-invalid' });
      } else if (record.expiresAt <= this.clock()) {
        this.signal({ gateDecision: 'owner-record-expired' });
      }
      return record;
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) {
        this.signal({ gateDecision: error.code === 'ENOENT' ? 'owner-record-unavailable' : 'owner-record-invalid' });
        return null;
      }
      throw error;
    }
  }

  async close() {
    clearInterval(this.timer);
    try {
      await this.publish(null);
    } finally {
      this.closed = true;
      this.signal({ gateDecision: 'closed' });
    }
  }
}
