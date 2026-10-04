const { randomUUID } = require('node:crypto');
const childProcess = require('node:child_process');
const { isAbsolute } = require('node:path');

const { createResourceManager, validateResourcePolicy, ResourceSetupError } = require('./resource-manager');

const { supportsOperation, validOperationResponse } = require('../agents/system-agent-contract');

const defaultAgentPath = require.resolve('../agents/system-agent-process');
const failure = (requestId, code, message) => ({ requestId, status: 'error', error: { code, message } });

function validResponse(message) {
  if (message.status === 'error') {
    return !('data' in message) && message.error !== null &&
      typeof message.error === 'object' && !Array.isArray(message.error) &&
      typeof message.error.code === 'string' && message.error.code.trim().length > 0 &&
      typeof message.error.message === 'string';
  }
  return message.status === 'success' && !('error' in message) && 'data' in message;
}

// Preserve synchronous disabled startup while accepting asynchronous resource operations.
function chain(value, next) {
  return value && typeof value.then === 'function' ? Promise.resolve(value).then(next) : next(value);
}

function resourceError(error, phase) {
  return { phase, code: error?.code || (['snapshot', 'dispose', 'rollback'].includes(phase) ? 'RESOURCE_CLEANUP_FAILED' : 'RESOURCE_SETUP_FAILED'),
    message: error?.message || String(error) };
}

async function finalSnapshot(manager, allocation, timeoutMs) {
  let timer;
  try {
    // Promise.race handles late rejection; late results cannot update metadata.
    return await Promise.race([
      Promise.resolve().then(() => manager.snapshot(allocation)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('Final resource snapshot timed out'), {
          code: 'RESOURCE_SNAPSHOT_TIMEOUT',
        })), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function createOrchestrator(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Orchestrator options must be an object');
  }
  const { agentPath = defaultAgentPath, startupTimeoutMs = 5000, terminationGraceMs = 500,
    resourceSnapshotTimeoutMs = 250,
    delegatedBasePath, resourceManager = createResourceManager({ delegatedBasePath }), resourcePolicy: requestedPolicy } = options;
  const resourcePolicy = validateResourcePolicy(requestedPolicy);
  for (const method of ['inspect', 'prepare', 'attach', 'snapshot', 'dispose']) {
    if (typeof resourceManager?.[method] !== 'function') throw new TypeError(`resourceManager.${method} must be a function`);
  }
  if (!isAbsolute(typeof agentPath === 'string' ? agentPath : '') || agentPath.includes('\0')) {
    throw new TypeError('agentPath must be an absolute path without null bytes');
  }
  for (const [name, value] of Object.entries({ startupTimeoutMs, terminationGraceMs, resourceSnapshotTimeoutMs })) {
    if (!Number.isInteger(value) || value < 1 || value > 2147483647) {
      throw new TypeError(`${name} must be an integer from 1 to 2147483647`);
    }
  }
  let state = 'STOPPED';
  let current;
  let closing = false;
  let closePromise;
  const pending = new Map();

  function settle(id, response) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(response);
  }

  function settleAll(code, message) {
    for (const id of pending.keys()) settle(id, failure(id, code, message));
  }

  function deliverSignal(run, signal) {
    try {
      if (run.child.kill(signal)) return;
      run.signalDeliveryErrors.push({ signal, code: 'SIGNAL_NOT_DELIVERED' });
    } catch (error) {
      run.signalDeliveryErrors.push({ signal, code: error.code || 'SIGNAL_DELIVERY_FAILED' });
    }
    // Keep ownership until exit; a failed SIGTERM still proceeds to SIGKILL.
  }

  // Exit is confirmed by Node, or by never having spawned a child.
  function terminate(run) {
    if (run.exited) return run.exitPromise;
    if (!run.child) {
      run.onExit(null, null);
      return run.exitPromise;
    }
    if (run.terminationPromise) return run.terminationPromise;
    state = 'STOPPING';
    run.terminationPromise = run.exitPromise;
    deliverSignal(run, 'SIGTERM');
    run.killTimer = setTimeout(() => {
      if (!run.exited) deliverSignal(run, 'SIGKILL');
    }, terminationGraceMs);
    return run.terminationPromise;
  }

  function failRun(run, code, message) {
    if (run.failure || run.exited) return;
    run.failure = { code, message };
    if (!run.initialized && code === 'AGENT_START_FAILED') {
      run.resources.setupError ??= { phase: run.resourcePhase, code, message };
      run.resources.enforcementStatus = 'unavailable';
    }
    clearTimeout(run.startupTimer);
    run.rejectStart(Object.assign(new Error(message), { code }));
    // Stop every deadline now; preserve the first failure during termination.
    for (const entry of pending.values()) clearTimeout(entry.timer);
    run.setupController.abort();
    void terminate(run);
  }

  function send(run, message) {
    try {
      run.child.send(message, (error) => {
        if (error) failRun(run, 'AGENT_DISCONNECTED', 'System Agent IPC send failed');
      });
    } catch {
      failRun(run, 'AGENT_DISCONNECTED', 'System Agent IPC send failed');
    }
  }

  function start() {
    if (closing) return Promise.reject(new Error('Runtime is closed'));
    if (state === 'READY') return Promise.resolve();
    if (state === 'STARTING') return current.startPromise;
    if (state === 'STOPPING') {
      if (current.exited) return current.cleanupPromise.then(() => start());
      return Promise.reject(new Error('System Agent is stopping'));
    }
    if (current?.resources.disposalFailed) {
      return Promise.reject(Object.assign(new Error('Prior resource disposal failed; restart is blocked'), { code: 'RESOURCE_CLEANUP_FAILED' }));
    }

    state = 'STARTING';
    const run = { instanceId: randomUUID(), exited: false, setupController: new AbortController(),
      signalDeliveryErrors: [], startedAt: new Date().toISOString(),
      resources: { requestedPolicy: resourcePolicy, enforcementStatus: resourcePolicy.mode === 'disabled' ? 'disabled' : 'pending',
        cgroupPath: null, capabilities: null, latestSnapshot: null, setupError: null, cleanupErrors: [], cleanupStatus: 'pending', disposalFailed: false } };
    current = run;
    run.startPromise = new Promise((resolve, reject) => {
      run.resolveStart = resolve;
      run.rejectStart = reject;
    });
    // A failure can precede a caller awaiting startup.
    run.startPromise.catch(() => {});
    run.exitPromise = new Promise((resolve) => { run.resolveExit = resolve; });
    run.setupPromise = new Promise((resolve) => { run.resolveSetup = resolve; });
    run.cleanupPromise = (async () => {
      await run.exitPromise;
      await run.setupPromise; // A late allocation still belongs to this instance.
      run.resources.cleanupStatus = 'running';
      if (run.allocation !== undefined) {
        try { run.resources.latestSnapshot = await finalSnapshot(resourceManager, run.allocation, resourceSnapshotTimeoutMs); }
        catch (error) { run.resources.cleanupErrors.push(resourceError(error, 'snapshot')); }
        try { await resourceManager.dispose(run.allocation); }
        catch (error) {
          run.resources.disposalFailed = true;
          run.resources.cleanupErrors.push(resourceError(error, 'dispose'));
        }
      }
      run.resources.cleanupStatus = run.resources.cleanupErrors.some(({ phase }) => phase !== 'rollback') ? 'failed' : 'complete';
      if (closing && !run.initialized && run.failure?.code === 'RUNTIME_CLOSED') {
        run.resources.enforcementStatus = 'cancelled';
      }
      state = closing ? 'CLOSED' : 'FAILED';
      const reason = run.failure;
      for (const [id, entry] of pending) {
        settle(id, entry.timeout ? failure(id, 'TIMEOUT', 'System Agent request timed out') : failure(id, reason.code, reason.message));
      }
    })();

    function onExit(code, signal) {
      if (run.exited) return;
      run.exited = true;
      clearTimeout(run.startupTimer);
      clearTimeout(run.killTimer);
      // Exit fixes the outcome. Observation/disposal latency must not create timeouts.
      for (const entry of pending.values()) clearTimeout(entry.timer);
      run.setupController.abort();
      run.exitCode = code;
      run.signalCode = signal;
      run.exitedAt = new Date().toISOString();
      run.rejectStart(new Error('System Agent exited before readiness'));
      state = 'STOPPING';
      const reason = run.failure || (closing
        ? { code: 'RUNTIME_CLOSED', message: 'Runtime is closed' }
        : { code: run.readyAt ? 'AGENT_EXITED' : 'AGENT_START_FAILED', message: 'System Agent exited' });
      run.failure = reason;
      if (!run.initialized && run.resources.enforcementStatus === 'pending') {
        run.resources.enforcementStatus = reason.code === 'RUNTIME_CLOSED' ? 'cancelled' : 'unavailable';
      }
      if (!run.child) settleAll(reason.code, reason.message);
      run.resolveExit();
    }

    run.onExit = onExit;

    function spawnAndAttach() {
      if (closing || run.failure || run.exited) return;
      run.resourcePhase = 'spawn';
      try {
        run.child = childProcess.fork(agentPath, [], {
          detached: false, execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        });
      } catch {
        failRun(run, 'AGENT_START_FAILED', 'Unable to start System Agent');
        return;
      }
      run.pid = run.child.pid ?? null;
      run.child.once('exit', onExit);
      run.child.on('error', () => {
        if (!run.child.pid) {
          run.failure ??= { code: 'AGENT_START_FAILED', message: 'Unable to start System Agent' };
          onExit(null, null);
        } else {
          failRun(run, 'AGENT_DISCONNECTED', 'System Agent process error');
        }
      });
      run.child.on('disconnect', () => {
        if (!closing && !run.exited) failRun(run, 'AGENT_DISCONNECTED', 'System Agent IPC disconnected');
      });
      run.child.on('message', (message) => {
        if (current !== run || run.exited || state === 'STOPPING') return;
        if (!message || typeof message !== 'object' || Array.isArray(message) || message.version !== 1 || message.instanceId !== run.instanceId) {
          failRun(run, 'PROTOCOL_ERROR', 'Invalid System Agent message');
          return;
        }
        if (message.type === 'ready' && state === 'STARTING' && run.initialized) {
          clearTimeout(run.startupTimer);
          run.readyAt = new Date().toISOString();
          state = 'READY';
          run.resolveStart();
          return;
        }
        if (state !== 'READY' || message.type !== 'response' || typeof message.requestId !== 'string' || !message.requestId.trim() || !validResponse(message)) {
          failRun(run, 'PROTOCOL_ERROR', 'Invalid System Agent response');
          return;
        }
        const entry = pending.get(message.requestId);
        if (!entry || !entry.dispatched) return;
        if (!validOperationResponse(entry.operation, message)) {
          failRun(run, 'PROTOCOL_ERROR', 'Invalid System Agent operation response');
          return;
        }
        const { requestId, status, data, error } = message;
        settle(requestId, status === 'success' ? { requestId, status, data } : { requestId, status, error });
      });
      // fork may report spawn failure asynchronously without ever assigning a PID.
      if (!Number.isInteger(run.pid) || run.pid <= 0) return;
      run.resourcePhase = 'attach';
      return chain(resourceManager.attach(run.allocation, run.pid, { signal: run.setupController.signal }), () => {
        if (closing || run.failure || run.exited) return;
        run.resources.enforcementStatus = run.allocation.enforcementStatus;
        run.initialized = true;
        send(run, { version: 1, type: 'initialize', instanceId: run.instanceId });
      });
    }

    function setupFailed(error) {
      if (error instanceof ResourceSetupError && run.resourcePhase === 'prepare') {
        if (error.allocation !== undefined) run.allocation = error.allocation;
        if (error.rollbackError !== undefined) run.resources.cleanupErrors.push(resourceError(error.rollbackError, 'rollback'));
      }
      run.resources.cgroupPath = run.allocation?.cgroupPath ?? null;
      run.resources.setupError ??= resourceError(error, run.resourcePhase);
      if (error instanceof ResourceSetupError) run.resources.setupError.originalError = resourceError(error.cause, run.resourcePhase);
      run.resources.capabilities = error?.capabilities ?? run.resources.capabilities;
      run.resources.enforcementStatus = 'unavailable';
      failRun(run, error?.code || 'RESOURCE_SETUP_FAILED', `Resource setup failed: ${error?.message || String(error)}`);
    }

    run.resourcePhase = 'prepare';
    run.startupTimer = setTimeout(() => failRun(run, 'AGENT_START_FAILED', 'System Agent startup timed out'), startupTimeoutMs);
    try {
      const setup = chain(resourceManager.prepare(run.instanceId, resourcePolicy, { signal: run.setupController.signal }), (allocation) => {
        if (!allocation || typeof allocation !== 'object') throw new TypeError('Resource manager prepare must return an allocation');
        run.allocation = allocation;
        run.resources.cgroupPath = allocation.cgroupPath ?? null;
        run.resources.capabilities = allocation.capabilities ?? null;
        if (!run.failure && !closing) run.resources.enforcementStatus = 'pending';
        const expected = resourcePolicy.mode === 'enforce' ? 'enforced' : resourcePolicy.mode;
        const allocationOnly = expected === 'enforced' && Object.keys(resourcePolicy).length === 1 && allocation.enforcementStatus === 'allocated';
        if (allocation.enforcementStatus !== expected && !allocationOnly) {
          throw Object.assign(new Error(`Resource manager did not provide ${expected} mode`), { code: 'RESOURCE_ENFORCEMENT_UNAVAILABLE' });
        }
        return spawnAndAttach();
      });
      Promise.resolve(setup).catch(setupFailed).finally(run.resolveSetup);
    } catch (error) {
      setupFailed(error);
      run.resolveSetup();
    }
    return run.startPromise;
  }

  function request(operation, timeoutMs = 1000) {
    const requestId = randomUUID();
    if (!supportsOperation(operation)) return Promise.resolve(failure(requestId, 'INVALID_REQUEST', 'Only get_system_info is supported'));
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
      return Promise.resolve(failure(requestId, 'INVALID_REQUEST', 'timeoutMs must be an integer from 1 to 2147483647'));
    }
    if (closing) return Promise.resolve(failure(requestId, 'RUNTIME_CLOSED', 'Runtime is closed'));
    if (state === 'FAILED' || state === 'STOPPING') return Promise.resolve(failure(requestId, 'AGENT_UNAVAILABLE', 'System Agent requires explicit restart after cleanup'));
    if (pending.size >= 64) return Promise.resolve(failure(requestId, 'AGENT_BUSY', 'Too many pending requests'));

    return new Promise((resolve) => {
      const entry = { resolve, operation, dispatched: false };
      pending.set(requestId, entry);
      entry.timer = setTimeout(() => {
        if (!entry.dispatched) {
          settle(requestId, failure(requestId, 'TIMEOUT', 'System Agent request timed out'));
          return;
        }
        entry.timeout = true;
        failRun(current, 'AGENT_TERMINATED', 'System Agent terminated after a request timeout');
      }, timeoutMs);
      start().then(() => {
        if (!pending.has(requestId) || closing || state !== 'READY') return;
        entry.dispatched = true;
        send(current, { version: 1, type: 'request', instanceId: current.instanceId, requestId, operation });
      }).catch(() => {
        // Failure settlement belongs to exit/cleanup, never to signal delivery.
      });
    });
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    settleAll('RUNTIME_CLOSED', 'Runtime is closed');
    closePromise = (async () => {
      const run = current;
      if (run && !run.exited) {
        state = 'STOPPING';
        run.setupController.abort();
        clearTimeout(run.startupTimer);
        run.rejectStart(new Error('Runtime is closed'));
        if (!run.child) {
          run.onExit(null, null);
        } else if (!run.terminationPromise) {
          send(run, { version: 1, type: 'shutdown', instanceId: run.instanceId });
          const graceTimer = setTimeout(() => { void terminate(run); }, terminationGraceMs);
          await run.exitPromise;
          clearTimeout(graceTimer);
        } else {
          await run.exitPromise;
        }
      }
      if (run) await run.cleanupPromise;
      state = 'CLOSED';
    })();
    return closePromise;
  }

  function getAgentMetadata() {
    return {
      agentId: 'system', instanceId: current?.instanceId ?? null, state,
      orchestratorPid: process.pid, pid: current?.pid ?? null,
      startedAt: current?.startedAt ?? null, readyAt: current?.readyAt ?? null,
      exitedAt: current?.exitedAt ?? null, exitCode: current?.exitCode ?? null,
      signalCode: current?.signalCode ?? null,
      terminationReason: current?.failure?.code ?? null, pendingRequestCount: pending.size,
      signalDeliveryErrors: current?.signalDeliveryErrors.map((error) => ({ ...error })) ?? [],
      resources: structuredClone(current?.resources ?? { requestedPolicy: resourcePolicy,
        enforcementStatus: resourcePolicy.mode === 'disabled' ? 'disabled' : closing ? 'cancelled' : 'pending',
        cgroupPath: null, capabilities: null, latestSnapshot: null, setupError: null, cleanupErrors: [], cleanupStatus: 'idle', disposalFailed: false }),
    };
  }

  return { start, request, close, getAgentMetadata };
}

module.exports = { createOrchestrator };
