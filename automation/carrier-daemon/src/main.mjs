import {readConfig} from './config.mjs';
import {createRepository} from './database.mjs';
import {createRunEngine} from './run.mjs';
import {closeServer, createStatusServer, listen} from './status-server.mjs';

function log(event, details = {}) {
  process.stdout.write(`${JSON.stringify({time: new Date().toISOString(), event, ...details})}\n`);
}

function runtimeState() {
  return {
    startedAt: Date.now(),
    initialized: false,
    runActive: false,
    breakerOpen: false,
    breakerReason: null,
    lastResult: null,
    lastCompletedAt: null,
  };
}

async function runOne(engine, state, signal) {
  if (state.runActive) return {kind: 'suppressed', reason: 'local_run_active'};
  state.runActive = true;
  try {
    const result = await engine({signal});
    state.lastResult = result.kind;
    state.lastCompletedAt = new Date().toISOString();
    log('carrier_run', {result});
    return result;
  } finally {
    state.runActive = false;
  }
}

async function main() {
  const config = readConfig();
  const state = runtimeState();
  const abortController = new AbortController();
  let poolFault;
  const repository = await createRepository({
    databaseUrl: config.databaseUrl,
    onPoolError: error => {
      poolFault = error;
      state.breakerOpen = true;
      state.breakerReason = 'PostgreSQL pool error';
      log('database_pool_error', {error: String(error?.message ?? error).slice(0, 300)});
    },
  });
  let server;
  let timer;
  let activeRun;
  let stopping = false;
  let resolveStop;
  const stopped = new Promise(resolve => { resolveStop = resolve; });

  const requestStop = signalName => {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    abortController.abort(new Error(`graceful shutdown: ${signalName}`));
    log('shutdown_requested', {signal: signalName});
    resolveStop();
  };
  const onSigterm = () => requestStop('SIGTERM');
  const onSigint = () => requestStop('SIGINT');
  process.once('SIGTERM', onSigterm);
  process.once('SIGINT', onSigint);

  try {
    await repository.initialize();
    state.initialized = true;
    const databaseState = await repository.status();
    if (databaseState.breakerOpen) {
      state.breakerOpen = true;
      state.breakerReason = databaseState.breakerReason;
    }
    const engine = createRunEngine({repository, config, runtimeState: state});

    if (config.mode === 'once') {
      const result = await runOne(engine, state, abortController.signal);
      if (result.kind === 'failed' || String(result.reason ?? '').includes('circuit_breaker')) {
        process.exitCode = 1;
      }
      return;
    }

    server = createStatusServer({repository, runtimeState: state, config});
    await listen(server, config.port);
    log('status_server_listening', {port: config.port});

    const schedule = delay => {
      if (stopping) return;
      timer = setTimeout(async () => {
        if (stopping) return;
        activeRun = runOne(engine, state, abortController.signal);
        try {
          await activeRun;
        } catch (error) {
          state.breakerOpen = true;
          state.breakerReason = 'unexpected scheduler failure';
          log('unexpected_scheduler_failure', {error: String(error?.message ?? error).slice(0, 300)});
          try {
            await repository.openBreaker({
              reason: 'unexpected scheduler failure',
              details: {error: String(error?.message ?? error).slice(0, 300)},
            });
          } catch (breakerError) {
            log('circuit_breaker_persist_failed', {error: String(breakerError?.message ?? breakerError).slice(0, 300)});
          }
        } finally {
          activeRun = null;
          schedule(config.intervalMs);
        }
      }, delay);
      timer.unref?.();
    };
    schedule(config.runImmediately ? 0 : config.intervalMs);
    await stopped;
  } finally {
    clearTimeout(timer);
    if (activeRun) {
      try {
        await activeRun;
      } catch {
        // The run records its own bounded result; shutdown continues.
      }
    }
    if (server) await closeServer(server);
    await repository.close();
    process.off('SIGTERM', onSigterm);
    process.off('SIGINT', onSigint);
    log('shutdown_complete', {pool_fault: Boolean(poolFault)});
  }
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({
    time: new Date().toISOString(),
    event: 'fatal_startup_error',
    error: String(error?.message ?? error).slice(0, 500),
  })}\n`);
  process.exitCode = 1;
});
