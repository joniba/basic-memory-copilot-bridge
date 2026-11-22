import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const importCodes = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_UNKNOWN_FILE_EXTENSION', 'ERR_DLOPEN_FAILED', 'EACCES', 'EPERM', 'ENOENT']);
const increment = value => Math.min(value + 1, Number.MAX_SAFE_INTEGER);
const contextKeys = ['event', 'gateDecision', 'operation', 'operationId', 'sessionId', 'requestId',
  'phase', 'compactionEpoch', 'trackingMode', 'recoveryPending', 'decision', 'attempts', 'contextRatio'];

function loadUtilities() {
  return Promise.all([
    import('./lib/diagnostics/trace.mjs'),
    import('./lib/logging/delivery.mjs'),
    import('./lib/logging/rotating-file.mjs'),
  ]);
}

export function createDiagnostics({
  path, sessionId, clock, codes, format, suppressionKey,
  load = loadUtilities, write, capacity = 256, fallback = value => console.error(value),
}) {
  let delivery;
  let quiet;
  let verbose;
  let debug = false;
  let closed = false;
  let unavailable = 0;
  let invalid = 0;
  let afterClose = 0;
  let reporter;
  let reportActive = false;
  let reportFailures = 0;
  let pendingFailure;
  let importing = true;
  let bootstrap = [];
  let bootstrapBytes = 0;
  let bootstrapRecordOverflow = 0;
  let bootstrapByteOverflow = 0;
  let bootstrapImportDiscarded = 0;
  let bootstrapShutdownDiscarded = 0;
  let bootstrapHandoffRefused = 0;
  let bootstrapForwarded = 0;

  function scheduleReport() {
    if (reporter || reportActive || !pendingFailure) return;
    reporter = setImmediate(async () => {
      reporter = undefined;
      reportActive = true;
      const failure = pendingFailure;
      pendingFailure = undefined;
      try {
        await fallback(JSON.stringify({
          timestamp: new Date(clock()).toISOString(), sessionId, event: 'bridge', gateDecision: 'diagnostic-error',
          ...(failure.original?.phase && { phase: failure.original.phase }),
          ...(failure.original?.operation && { operation: failure.original.operation }),
          ...(failure.original?.code !== undefined && { code: failure.original.code }),
          ...(failure.original?.errorType && { errorType: failure.original.errorType }),
          ...failure, unavailable, invalid, reportFailures,
          bootstrapRecordOverflow, bootstrapByteOverflow, bootstrapImportDiscarded,
          bootstrapShutdownDiscarded, bootstrapHandoffRefused,
        }));
      } catch {
        reportFailures = increment(reportFailures);
      } finally {
        reportActive = false;
        scheduleReport();
      }
    });
    if (closed) reporter.unref();
  }

  function report(original, diagnosticFailure = { operation: 'diagnostic.write', code: 'UNKNOWN', errorType: 'UNKNOWN' },
    details = {}) {
    pendingFailure = { original, diagnosticFailure, ...details };
    scheduleReport();
  }

  function origin(record) {
    return Object.fromEntries([...contextKeys, 'code', 'errorType']
      .filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]]));
  }

  function discardBootstrap(reason) {
    const pending = bootstrap;
    bootstrap = [];
    bootstrapBytes = 0;
    if (!pending.length) return;
    if (reason === 'import') bootstrapImportDiscarded += pending.length;
    else bootstrapShutdownDiscarded += pending.length;
    const records = pending.map(encoded => JSON.parse(encoded));
    const record = records.findLast(value => value.gateDecision?.endsWith('-error')) ?? records.at(-1);
    const original = origin(record);
    if (reason !== 'import') report(original, undefined, { bootstrapDiscardReason: reason });
    return original;
  }

  function handoffBootstrap() {
    const pending = bootstrap;
    bootstrap = [];
    bootstrapBytes = 0;
    for (const encoded of pending) {
      const record = JSON.parse(encoded);
      let accepted = 0;
      try { accepted = delivery.submit(record, { suppressionKey: suppressionKey(record) }); }
      catch { invalid = increment(invalid); }
      if (accepted > 0) bootstrapForwarded = increment(bootstrapForwarded);
      else {
        bootstrapHandoffRefused = increment(bootstrapHandoffRefused);
        report(origin(record), undefined, { bootstrapDiscardReason: 'handoff-refused' });
      }
    }
  }

  function breadcrumb(gateDecision, details = {}) {
    try {
      const submitted = fallback(JSON.stringify({
        timestamp: new Date(clock()).toISOString(), sessionId, event: 'diagnostics', gateDecision, ...details,
      }));
      if (typeof submitted?.then === 'function') {
        Promise.resolve(submitted).catch(() => { reportFailures = increment(reportFailures); });
      }
    } catch {
      reportFailures = increment(reportFailures);
    }
  }

  const ready = Promise.resolve().then(() => {
    breadcrumb('logging-import-start');
    return load();
  }).then(([{ createOperationTracer }, { createLogDelivery }, { createRotatingFileSink }]) => {
    importing = false;
    if (closed) return false;
    const sink = write ?? createRotatingFileSink({ path, maxBytes: 1024 * 1024, backups: 2, separatePartialLine: true });
    const nextDelivery = createLogDelivery({
      capacity, codes, contextKeys, suppressionMs: 60000,
      destinations: [{
        name: 'file',
        write: async record => {
          await mkdir(dirname(path), { recursive: true });
          await sink(record);
        },
      }],
      onLoss: health => {
        const file = health.destinations[0];
        if (file.lastFailure) {
          const { original, diagnostic, outcome } = file.lastFailure;
          report(original, { operation: 'diagnostic.write', ...diagnostic }, {
            outcome, overflow: file.overflow, discarded: file.discarded,
          });
        } else {
          report(undefined, undefined, { overflow: file.overflow, discarded: file.discarded });
        }
      },
    });
    const nextQuiet = createOperationTracer({ submit: record => log(record), codes, contextKeys: contextKeys.filter(key => key !== 'operationId') });
    const nextVerbose = createOperationTracer({
      submit: record => log(record), debug: true, codes,
      contextKeys: contextKeys.filter(key => key !== 'operationId'),
    });
    if (typeof nextQuiet?.run !== 'function' || typeof nextVerbose?.run !== 'function') {
      throw new TypeError('Invalid installed operation tracer.');
    }
    delivery = nextDelivery;
    quiet = nextQuiet;
    verbose = nextVerbose;
    handoffBootstrap();
    breadcrumb('logging-import-complete');
    return true;
  }).catch(error => {
    importing = false;
    const discarded = discardBootstrap('import');
    let code = 'UNKNOWN';
    let errorType = 'UNKNOWN';
    try {
      if (importCodes.has(error?.code)) code = error.code;
      if (['Error', 'TypeError', 'SyntaxError', 'RangeError', 'ReferenceError'].includes(error?.name)) errorType = error.name;
    } catch {
      invalid = increment(invalid);
    }
    breadcrumb('logging-import-error', { operation: 'diagnostic.import', code, errorType });
    report(discarded ?? { event: 'diagnostics', operation: 'diagnostic.import', phase: 'initialization', sessionId },
      { operation: 'diagnostic.import', code, errorType }, { bootstrapDiscardReason: 'import' });
    return false;
  });

  function log(record) {
    if (closed) {
      afterClose = increment(afterClose);
      return 0;
    }
    let safe;
    try {
      safe = format(record);
      if (!delivery) {
        if (importing && !safe.gateDecision?.startsWith('operation-')) {
          const encoded = JSON.stringify(safe);
          const bytes = Buffer.byteLength(encoded, 'utf8');
          if (bootstrap.length < 16 && bootstrapBytes + bytes <= 16_384) {
            bootstrap.push(encoded);
            bootstrapBytes += bytes;
            return 1;
          }
          if (bootstrap.length >= 16) bootstrapRecordOverflow = increment(bootstrapRecordOverflow);
          else bootstrapByteOverflow = increment(bootstrapByteOverflow);
        }
        unavailable = increment(unavailable);
        report(origin(safe));
        return 0;
      }
      return delivery.submit(safe, { suppressionKey: suppressionKey(safe) });
    } catch {
      invalid = increment(invalid);
      report(safe && origin(safe));
      return 0;
    }
  }

  log.trace = (operation, action, context = {}) => {
    if (!delivery || !quiet || !verbose || closed) {
      log({ event: `${operation}.started`, gateDecision: 'operation-started', operation, ...context });
      return action();
    }
    return (debug ? verbose : quiet).run(operation, action, { ...context, operation });
  };
  log.ready = ready;
  log.setDebug = value => { debug = value; };
  log.getHealth = () => ({
    unavailable, invalid, afterClose, closed, reportActive, reportFailures,
    bootstrap: {
      pending: bootstrap.length, bytes: bootstrapBytes, recordOverflow: bootstrapRecordOverflow,
      byteOverflow: bootstrapByteOverflow, importDiscarded: bootstrapImportDiscarded,
      shutdownDiscarded: bootstrapShutdownDiscarded, handoffRefused: bootstrapHandoffRefused,
      forwarded: bootstrapForwarded,
    },
    admissionFailures: Math.min(Number.MAX_SAFE_INTEGER,
      (quiet?.getHealth().admissionFailures ?? 0) + (verbose?.getHealth().admissionFailures ?? 0)),
    ...(delivery && { delivery: delivery.getHealth() }),
  });
  log.close = () => {
    closed = true;
    discardBootstrap('shutdown');
    delivery?.close();
    reporter?.unref();
  };
  return log;
}
