import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const validName = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);

export class StatusPublisher {
  constructor(directory, sessionId, provider, {
    clock = Date.now, lifetime = 30000, renewInterval = 10000,
    report = () => console.error('status-contribution: renewal-error'),
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
    this.closed = false;
    this.queue = Promise.resolve();
    this.report = report;
    this.timer = setInterval(() => {
      if (this.current && !this.closed) this.renew().catch(report);
    }, renewInterval);
    this.timer.unref();
  }

  publish(contribution) {
    return this.enqueue(() => this.write(contribution));
  }

  renew() {
    return this.enqueue(() => this.write(this.current));
  }

  enqueue(write) {
    const action = this.queue.then(write);
    this.queue = action.catch(this.report);
    return action;
  }

  async write(contribution) {
    if (this.closed) return;
    await mkdir(this.directory, { recursive: true });
    const lockPath = `${this.path}.lock`;
    const lock = await open(lockPath, 'wx');
    let temporary;
    try {
      if (this.claimed) {
        let previous;
        try {
          previous = JSON.parse(await readFile(this.path, 'utf8'));
        } catch (error) {
          if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
        if (previous && previous.owner !== this.owner) {
          this.closed = true;
          clearInterval(this.timer);
          return;
        }
      }
      const now = this.clock();
      const value = contribution ? {
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
      const record = {
        version: 1, sessionId: this.sessionId, owner: this.owner,
        expiresAt: value ? now + this.lifetime : now, contribution: value,
      };
      const content = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(content) > 16384) throw new Error('status-size-invalid');
      temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.path);
      temporary = null;
      this.claimed = true;
      this.current = value;
    } finally {
      try {
        if (temporary) await unlink(temporary);
      } finally {
        await lock.close();
        await unlink(lockPath);
      }
    }
  }

  async close() {
    clearInterval(this.timer);
    try {
      await this.publish(null);
    } finally {
      this.closed = true;
    }
  }
}
