import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, unlink, writeFile } from 'node:fs/promises';
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
const contentionCode = process.platform === 'win32' ? 'EADDRINUSE' : 'EEXIST';

async function holdLock(publisher) {
  const lock = await publisher.acquireLock();
  return async () => {
    await lock.close();
    if (process.platform !== 'win32') await unlink(`${publisher.path}.lock`);
  };
}

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
  const release = await holdLock(publisher);
  const before = await readFile(publisher.path, 'utf8');
  try {
    await assert.rejects(publisher.publish(activity('Updated')), error =>
      error.operation === 'lock-acquire' && error.code === contentionCode);
    assert.equal(await readFile(publisher.path, 'utf8'), before);
    assert.deepEqual(diagnostics, [{
      event: 'status-contribution', operation: 'lock-acquire', code: contentionCode, decision: 'failed', attempts: 6,
    }]);
  } finally {
    await release();
    await publisher.close();
  }
});

test('brief live lock contention retries without taking the other writer lock', async () => {
  const diagnostics = [];
  const publisher = new StatusPublisher(directory, 'brief-lock', 'provider', {
    report: error => diagnostics.push(publicationDiagnostic(error)),
  });
  await publisher.publish(activity('Initial'));
  const unlock = await holdLock(publisher);
  const release = delay(100).then(unlock);
  try {
    await publisher.publish(activity('Updated'));
    await release;
    assert.equal(JSON.parse(await readFile(publisher.path, 'utf8')).contribution.label, 'Updated');
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].operation, 'lock-acquire');
    assert.equal(diagnostics[0].code, contentionCode);
    assert.equal(diagnostics[0].decision, 'recovered');
    assert.ok(diagnostics[0].attempts > 1);
  } finally {
    await release;
    await publisher.close();
  }
});

test('Windows publication never creates a persistent lock file and ignores old orphan markers without deleting them', {
  skip: process.platform !== 'win32',
}, async () => {
  const publisher = new StatusPublisher(directory, 'legacy-orphan', 'provider', { report: () => {} });
  const oldLock = `${publisher.path}.lock`;
  try {
    await publisher.publish(activity('Initial'));
    await assert.rejects(stat(oldLock), { code: 'ENOENT' });
    await writeFile(oldLock, '');
    await publisher.publish(activity('Recovered despite old marker'));
    assert.equal(JSON.parse(await readFile(publisher.path, 'utf8')).contribution.label, 'Recovered despite old marker');
    assert.equal(await readFile(oldLock, 'utf8'), '');
    await publisher.close();
    assert.equal(await readFile(oldLock, 'utf8'), '');
  } finally {
    await publisher.close();
  }
});

test('Windows publishers for differently cased paths share the same live kernel lock', {
  skip: process.platform !== 'win32',
}, async () => {
  const first = new StatusPublisher(directory, 'case-lock', 'provider', { report: () => {} });
  const second = new StatusPublisher(directory.toUpperCase(), 'case-lock', 'provider', { report: () => {} });
  await first.publish(activity('Initial'));
  const release = await holdLock(first);
  try {
    await assert.rejects(second.publish(activity('Must wait')), error =>
      error.operation === 'lock-acquire' && error.code === 'EADDRINUSE');
    assert.equal(JSON.parse(await readFile(first.path, 'utf8')).contribution.label, 'Initial');
  } finally {
    await release();
    await first.close();
    await second.close();
  }
});

test('Windows releases the live publication lock on process exit even when publication cleanup never runs', {
  skip: process.platform !== 'win32',
}, async () => {
  const module = new URL('../extension/status-publisher.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { StatusPublisher } from ${JSON.stringify(module)};
    const publisher = new StatusPublisher(${JSON.stringify(directory)}, 'crashed-owner', 'provider');
    await publisher.publish({ kind: 'activity', priority: 100, color: 'yellow', label: 'Previous complete record' });
    publisher.readRecord = () => {
      process.stdout.write('LOCK_HELD\\n');
      return new Promise(() => {});
    };
    process.stdin.once('data', () => process.exit(17));
    await publisher.publish({ kind: 'activity', priority: 100, color: 'yellow', label: 'Never committed' });
  `], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 17 ? resolve() : reject(new Error(`Fixture exited ${code}: ${stderr}`)));
  });
  const diagnostics = [];
  const replacement = new StatusPublisher(directory, 'crashed-owner', 'provider', {
    report: error => diagnostics.push(publicationDiagnostic(error)),
  });
  try {
    await new Promise((resolve, reject) => {
      let stdout = '';
      child.stdout.on('data', bytes => {
        stdout += bytes.toString();
        if (stdout.includes('LOCK_HELD')) resolve();
      });
      child.once('error', reject);
      child.once('exit', () => stdout.includes('LOCK_HELD') || reject(new Error('Fixture exited before holding the lock.')));
    });
    assert.equal(JSON.parse(await readFile(replacement.path, 'utf8')).contribution.label, 'Previous complete record');
    await assert.rejects(stat(`${replacement.path}.lock`), { code: 'ENOENT' });
    const publish = replacement.publish(activity('Replacement owner'));
    await delay(75);
    child.stdin.end('exit without cleanup');
    await exited;
    await publish;
    const record = JSON.parse(await readFile(replacement.path, 'utf8'));
    assert.equal(record.owner, replacement.owner);
    assert.equal(record.contribution.label, 'Replacement owner');
    assert.ok(diagnostics.some(row => row.operation === 'lock-acquire'
      && row.code === 'EADDRINUSE' && row.decision === 'recovered'));
    assert.ok(diagnostics.every(row => row.decision === 'recovered'));
    await assert.rejects(stat(`${replacement.path}.lock`), { code: 'ENOENT' });
  } finally {
    if (child.exitCode === null) child.stdin.end('exit fixture');
    await exited;
    await replacement.close();
  }
});

test('a failed update leaves heartbeat intent on the new label, not the last successful label', async () => {
  const publisher = new StatusPublisher(directory, 'latest-intent', 'provider', { report: () => {} });
  await publisher.publish(activity('Queued'));
  const release = await holdLock(publisher);
  try {
    await assert.rejects(publisher.publish(activity('In progress')));
  } finally {
    await release();
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
  const release = await holdLock(publisher);
  try {
    await assert.rejects(publisher.publish(null));
    assert.equal(publisher.current, null);
    await delay(50);
    assert.equal(await readFile(publisher.path, 'utf8'), original);
  } finally {
    await release();
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
  const release = await holdLock(first);
  try {
    await assert.rejects(first.publish(activity('Older attempt')));
    assert.equal(first.claimed, false);
    assert.equal(first.expectedOwner, null);
  } finally {
    await release();
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
  const release = await holdLock(publisher);
  try {
    const deadline = Date.now() + 5000;
    while (!diagnostics.length && Date.now() < deadline) await delay(10);
    clearInterval(publisher.timer);
    assert.deepEqual(diagnostics, [{
      event: 'status-contribution', operation: 'lock-acquire', code: contentionCode, decision: 'failed', attempts: 6,
    }]);
  } finally {
    await release();
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
