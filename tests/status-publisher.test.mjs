import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { StatusPublisher, publicationDiagnostic } from '../extension/status-publisher.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(root, '.test-artifacts'), { recursive: true });
const directory = await mkdtemp(join(root, '.test-artifacts', 'publisher-rca-'));
const activity = label => ({ kind: 'activity', priority: 100, color: 'yellow', label });

test('publication diagnostics contain only known operation and filesystem error codes', () => {
  assert.deepEqual(publicationDiagnostic({
    operation: 'replace', code: 'EPERM', message: 'private-path-and-payload', stack: 'private-stack',
  }), { event: 'status-contribution', operation: 'replace', code: 'EPERM', decision: 'failed', attempts: 1 });
  assert.deepEqual(publicationDiagnostic({
    operation: 'private-operation', code: 'PRIVATE_VALUE', message: 'private-payload',
  }), { event: 'status-contribution', operation: 'unknown', code: 'UNKNOWN', decision: 'failed', attempts: 1 });
});

test('actual lock contention is identified without stealing or deleting the lock', async () => {
  const diagnostics = [];
  const publisher = new StatusPublisher(directory, 'lock-test', 'provider', {
    report: error => diagnostics.push(publicationDiagnostic(error)),
  });
  await publisher.publish(activity('Initial'));
  const lockPath = `${publisher.path}.lock`;
  const lock = await open(lockPath, 'wx');
  const before = await readFile(publisher.path, 'utf8');
  try {
    await assert.rejects(publisher.publish(activity('Updated')), error =>
      error.operation === 'lock-acquire' && error.code === 'EEXIST');
    assert.equal(await readFile(publisher.path, 'utf8'), before);
    assert.deepEqual(diagnostics, [{
      event: 'status-contribution', operation: 'lock-acquire', code: 'EEXIST', decision: 'failed', attempts: 6,
    }]);
  } finally {
    await lock.close();
    await unlink(lockPath);
    await publisher.close();
  }
});

test('brief live lock contention retries without taking the other writer lock', async () => {
  const diagnostics = [];
  const publisher = new StatusPublisher(directory, 'brief-lock', 'provider', {
    report: error => diagnostics.push(publicationDiagnostic(error)),
  });
  await publisher.publish(activity('Initial'));
  const path = `${publisher.path}.lock`;
  const lock = await open(path, 'wx');
  const release = delay(100).then(async () => {
    await lock.close();
    await unlink(path);
  });
  try {
    await publisher.publish(activity('Updated'));
    await release;
    assert.equal(JSON.parse(await readFile(publisher.path, 'utf8')).contribution.label, 'Updated');
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].operation, 'lock-acquire');
    assert.equal(diagnostics[0].code, 'EEXIST');
    assert.equal(diagnostics[0].decision, 'recovered');
    assert.ok(diagnostics[0].attempts > 1);
  } finally {
    await release;
    await publisher.close();
  }
});

test('a failed update leaves heartbeat intent on the new label, not the last successful label', async () => {
  const publisher = new StatusPublisher(directory, 'latest-intent', 'provider', { report: () => {} });
  await publisher.publish(activity('Queued'));
  const path = `${publisher.path}.lock`;
  const lock = await open(path, 'wx');
  try {
    await assert.rejects(publisher.publish(activity('In progress')));
  } finally {
    await lock.close();
    await unlink(path);
  }
  try {
    await publisher.renew();
    assert.equal(JSON.parse(await readFile(publisher.path, 'utf8')).contribution.label, 'In progress');
  } finally {
    await publisher.close();
  }
});

test('a failed clear cannot renew a stale in-progress contribution', async () => {
  const publisher = new StatusPublisher(directory, 'failed-clear', 'provider', { report: () => {} });
  await publisher.publish(activity('In progress'));
  const original = await readFile(publisher.path, 'utf8');
  const path = `${publisher.path}.lock`;
  const lock = await open(path, 'wx');
  try {
    await assert.rejects(publisher.publish(null));
    assert.equal(publisher.current, null);
    await delay(50);
    assert.equal(await readFile(publisher.path, 'utf8'), original);
  } finally {
    await lock.close();
    await unlink(path);
  }
  try {
    await publisher.renew();
    assert.equal(JSON.parse(await readFile(publisher.path, 'utf8')).contribution, null);
  } finally {
    await publisher.close();
  }
});

test('a previously unclaimed publisher cannot overwrite a newer owner after its first publication failed', async () => {
  const root = await mkdtemp(join(directory, 'first-claim-'));
  const first = new StatusPublisher(root, 'owner-race', 'provider', { report: () => {} });
  const second = new StatusPublisher(root, 'owner-race', 'provider', { report: () => {} });
  await mkdir(first.directory, { recursive: true });
  const path = `${first.path}.lock`;
  const lock = await open(path, 'wx');
  try {
    await assert.rejects(first.publish(activity('Older attempt')));
    assert.equal(first.claimed, false);
    assert.equal(first.expectedOwner, null);
  } finally {
    await lock.close();
    await unlink(path);
  }
  try {
    await second.publish(activity('New owner'));
    await first.renew();
    await first.close();
    const record = JSON.parse(await readFile(second.path, 'utf8'));
    assert.equal(record.owner, second.owner);
    assert.equal(record.contribution.label, 'New owner');
    assert.equal(first.closed, true);
  } finally {
    await first.close();
    await second.close();
  }
});

test('automatic renewal reports a persistent failure once, rather than logging it twice', async () => {
  const diagnostics = [];
  const publisher = new StatusPublisher(directory, 'renewal-once', 'provider', {
    lifetime: 5000, renewInterval: 1000,
    report: error => diagnostics.push(publicationDiagnostic(error)),
  });
  await publisher.publish(activity('Working'));
  const path = `${publisher.path}.lock`;
  const lock = await open(path, 'wx');
  try {
    const deadline = Date.now() + 5000;
    while (!diagnostics.length && Date.now() < deadline) await delay(10);
    clearInterval(publisher.timer);
    assert.deepEqual(diagnostics, [{
      event: 'status-contribution', operation: 'lock-acquire', code: 'EEXIST', decision: 'failed', attempts: 6,
    }]);
  } finally {
    await lock.close();
    await unlink(path);
    await publisher.close();
  }
});

test('permanent directory errors fail explicitly without sharing retries', async () => {
  const invalidDirectory = join(directory, 'file-not-directory');
  await writeFile(invalidDirectory, 'synthetic fixture');
  const diagnostics = [];
  const publisher = new StatusPublisher(invalidDirectory, 'permanent-error', 'provider', {
    report: error => diagnostics.push(publicationDiagnostic(error)),
  });
  try {
    await assert.rejects(publisher.publish(activity('Working')), error =>
      error.operation === 'mkdir' && error.code === 'ENOTDIR' && error.attempts === 1);
    assert.equal(diagnostics.length, 1);
    assert.equal(await readFile(invalidDirectory, 'utf8'), 'synthetic fixture');
  } finally {
    clearInterval(publisher.timer);
  }
});

test('invalid contribution encoding reports a fixed code and stops renewing old activity', async () => {
  const diagnostics = [];
  const publisher = new StatusPublisher(directory, 'invalid-data', 'provider', {
    report: error => diagnostics.push(publicationDiagnostic(error)),
  });
  try {
    await publisher.publish(activity('Old activity'));
    await assert.rejects(publisher.publish({ kind: 'hint', labels: {}, targets: null }), error =>
      error.operation === 'encode' && error.code === 'INVALID');
    assert.equal(publisher.current, null);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].attempts, 1);
    assert.ok(!JSON.stringify(diagnostics).includes('Old activity'));
  } finally {
    await publisher.close();
  }
});

test('oversized contributions report a size limit without retaining or publishing the payload', async () => {
  const diagnostics = [];
  const publisher = new StatusPublisher(directory, 'oversized-data', 'provider', {
    report: error => diagnostics.push(publicationDiagnostic(error)),
  });
  try {
    await publisher.publish(activity('Initial'));
    const before = await readFile(publisher.path, 'utf8');
    await assert.rejects(publisher.publish(activity('PRIVATE_SYNTHETIC'.repeat(2000))), error =>
      error.operation === 'encode' && error.code === 'LIMIT');
    assert.equal(publisher.current, null);
    assert.equal(await readFile(publisher.path, 'utf8'), before);
    assert.ok(!JSON.stringify(diagnostics).includes('PRIVATE_SYNTHETIC'));
  } finally {
    await publisher.close();
  }
});

test('Windows read handles denying replacement recover during bounded retry', { skip: process.platform !== 'win32' }, async () => {
  const diagnostics = [];
  const publisher = new StatusPublisher(directory, 'windows-replace', 'provider', {
    report: error => diagnostics.push(publicationDiagnostic(error)),
  });
  await publisher.publish(activity('Initial'));
  const reader = spawn('pwsh', ['-NoProfile', '-Command',
    `$f=[IO.File]::Open('${publisher.path.replaceAll("'", "''")}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try { [Console]::WriteLine('LOCKED'); [Console]::Out.Flush(); Start-Sleep -Milliseconds 300 } finally { $f.Dispose() }`],
  { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const exited = new Promise((resolve, reject) => {
    reader.once('error', reject);
    reader.once('exit', code => code === 0 ? resolve() : reject(new Error('Synthetic sharing reader failed')));
  });
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      reader.stdout.on('data', chunk => {
        output += chunk.toString();
        if (output.includes('LOCKED')) resolve();
      });
      reader.once('error', reject);
      reader.once('exit', () => output.includes('LOCKED') || reject(new Error('Reader did not acquire the synthetic handle')));
    });
    await publisher.publish(activity('Updated'));
    await exited;
    assert.equal(JSON.parse(await readFile(publisher.path, 'utf8')).contribution.label, 'Updated');
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].operation, 'replace');
    assert.equal(diagnostics[0].code, 'EPERM');
    assert.equal(diagnostics[0].decision, 'recovered');
    assert.ok(diagnostics[0].attempts > 1);
  } finally {
    await exited;
    await publisher.close();
  }
});
