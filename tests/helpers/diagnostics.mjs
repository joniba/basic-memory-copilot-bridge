import { setTimeout as delay } from 'node:timers/promises';
import { createLogger as bridgeLogger } from '../../extension/bridge.mjs';

export const loadUtilities = () => Promise.all([
  import('copilot-extension-utils/diagnostics/trace'),
  import('copilot-extension-utils/logging/delivery'),
  import('copilot-extension-utils/logging/rotating-file'),
]);

export function createLogger(directory, sessionId, clock, options = {}) {
  return bridgeLogger(directory, sessionId, clock, { load: loadUtilities, fallback: () => {}, ...options });
}

export async function settleLogger(logger) {
  if (!await logger.ready) throw new Error('Fixture utility loading failed.');
  const deadline = Date.now() + 20000;
  while (logger.getHealth().delivery.destinations.some(value => value.active || value.pending)) {
    if (Date.now() >= deadline) throw new Error('Fixture log destination did not settle.');
    await delay(2);
  }
}
