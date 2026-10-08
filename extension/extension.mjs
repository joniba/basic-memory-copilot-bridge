import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinSession } from '@github/copilot-sdk/extension';
import { CaptureBridge, createLogger, FileStateStore, validateConfig } from './bridge.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const home = process.env.COPILOT_HOME || join(homedir(), '.copilot');
let session;
try {
  session = await joinSession({ tools: [], hooks: {} });
  const stateRoot = join(home, 'extension-state', 'basic-memory-bridge');
  const bridge = new CaptureBridge({
    session,
    store: new FileStateStore(join(stateRoot, 'sessions'), session.sessionId),
    config: async () => validateConfig(JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))),
    log: createLogger(join(stateRoot, 'logs'), session.sessionId),
  });
  bridge.start();
  session.on(event => bridge.on(event));
} catch {
  console.error('{"event":"startup","gateDecision":"connection-error"}');
  if (session) {
    await session.log('Basic Memory bridge failed to attach; automatic capture is unavailable.', { level: 'warning' })
      .catch(() => console.error('{"event":"startup","gateDecision":"diagnostic-error"}'));
  }
}
