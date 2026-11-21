import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const home = process.env.COPILOT_HOME || join(homedir(), '.copilot');
const startedAt = Date.now();
const sdkVersion = /[\\/]([^\\/]+)[\\/]copilot-sdk[\\/]?$/.exec(process.env.COPILOT_SDK_PATH ?? '')?.[1];
const importCodes = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_DLOPEN_FAILED', 'ERR_UNKNOWN_FILE_EXTENSION', 'EACCES', 'EPERM', 'ENOENT']);
const errorTypes = new Set(['Error', 'TypeError', 'SyntaxError', 'RangeError', 'ReferenceError']);
let stage;
let diagnostic = error => ({
  operation: 'unknown',
  code: importCodes.has(error?.code) ? error.code : 'UNKNOWN',
  errorType: errorTypes.has(error?.name) ? error.name : 'UNKNOWN',
});
function startup(next, details = {}) {
  stage = next;
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(), event: 'startup', gateDecision: next,
    elapsedMs: Date.now() - startedAt, ...details,
  }));
}
function startupFailure(error) {
  const failedStage = stage;
  startup('connection-error', { failedStage, ...diagnostic(error) });
}

startup('entry', {
  nodeVersion: process.versions.node,
  ...(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$/.test(sdkVersion ?? '') ? { sdkVersion } : {}),
});
let session;
let bridge;
try {
  startup('sdk-import-start');
  const { joinSession } = await import('@github/copilot-sdk/extension');
  startup('sdk-import-complete');
  startup('bridge-import-start');
  const { bridgeDiagnostic, CaptureBridge, createLogger, FileStateStore, validateConfig } = await import('./bridge.mjs');
  diagnostic = error => ({
    ...bridgeDiagnostic(error),
    ...(importCodes.has(error?.code) ? { code: error.code } : {}),
  });
  startup('bridge-import-complete');
  startup('status-import-start');
  const { StatusPublisher } = await import('./status-publisher.mjs');
  startup('status-import-complete');
  startup('commands-import-start');
  const { bridgeCommand } = await import('./commands.mjs');
  startup('commands-import-complete');
  startup('session-join-start');
  session = await joinSession({
    tools: [], hooks: {},
    commands: [bridgeCommand(join(root, 'config.json'), () => bridge)],
  });
  startup('session-join-complete');
  const stateRoot = join(home, 'extension-state', 'basic-memory-bridge');
  const publisher = new StatusPublisher(join(home, 'statusline', 'contributions'), session.sessionId, 'basic-memory-bridge');
  bridge = new CaptureBridge({
    session,
    store: new FileStateStore(join(stateRoot, 'sessions'), session.sessionId, {
      legacyDirectory: join(home, 'plugin-data', '_direct'),
    }),
    config: async () => validateConfig(JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))),
    log: createLogger(join(stateRoot, 'logs'), session.sessionId),
    status: value => publisher.publish(value),
  });
  startup('bridge-initialize-start');
  void bridge.start().then(() => startup(bridge.ready ? 'bridge-ready' : 'bridge-not-ready'))
    .catch(startupFailure);
  session.on(event => bridge.on(event));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    publisher.close().catch(() => console.error('{"event":"shutdown","gateDecision":"status-error"}'))
      .finally(() => process.exit(0));
  });
  session.on('session.shutdown', () => publisher.close()
    .catch(() => console.error('{"event":"shutdown","gateDecision":"status-error"}')));
} catch (error) {
  startupFailure(error);
  if (session) {
    await session.log('[basic-memory-bridge] Failed to attach; automatic capture is unavailable.', { level: 'warning' })
      .catch(() => console.error('{"event":"startup","gateDecision":"diagnostic-error"}'));
  }
}
