const { randomUUID } = require('node:crypto');
const childProcess = require('node:child_process');
const { isAbsolute } = require('node:path');

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

function createOrchestrator(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Orchestrator options must be an object');
  }
  const { agentPath = defaultAgentPath, startupTimeoutMs = 5000, terminationGraceMs = 500 } = options;
  if (!isAbsolute(typeof agentPath === 'string' ? agentPath : '') || agentPath.includes('\0')) {
    throw new TypeError('agentPath must be an absolute path without null bytes');
  }
  for (const [name, value] of Object.entries({ startupTimeoutMs, terminationGraceMs })) {
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

  // This promise resolves only when Node observes the child's actual exit.
  function terminate(run) {
    if (run.exited) return run.exitPromise;
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
    clearTimeout(run.startupTimer);
    run.rejectStart(new Error(message));
    // Stop every deadline now; preserve the first failure during termination.
    for (const entry of pending.values()) clearTimeout(entry.timer);
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
    if (state === 'STOPPING') return Promise.reject(new Error('System Agent is stopping'));

    state = 'STARTING';
    const run = { instanceId: randomUUID(), exited: false, signalDeliveryErrors: [], startedAt: new Date().toISOString() };
    current = run;
    run.startPromise = new Promise((resolve, reject) => {
      run.resolveStart = resolve;
      run.rejectStart = reject;
    });
    // A failure can precede a caller awaiting startup.
    run.startPromise.catch(() => {});
    run.exitPromise = new Promise((resolve) => { run.resolveExit = resolve; });
    try {
      run.child = childProcess.fork(agentPath, [], {
        detached: false,
        execArgv: [],
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
    } catch {
      run.exited = true;
      run.exitedAt = new Date().toISOString();
      run.failure = { code: 'AGENT_START_FAILED', message: 'Unable to start System Agent' };
      state = 'FAILED';
      run.rejectStart(new Error(run.failure.message));
      run.resolveExit();
      settleAll(run.failure.code, run.failure.message);
      return run.startPromise;
    }
    run.pid = run.child.pid ?? null;

    function onExit(code, signal) {
      if (run.exited) return;
      run.exited = true;
      clearTimeout(run.startupTimer);
      clearTimeout(run.killTimer);
      run.exitCode = code;
      run.signalCode = signal;
      run.exitedAt = new Date().toISOString();
      run.rejectStart(new Error('System Agent exited before readiness'));
      state = closing ? 'CLOSED' : 'FAILED';
      const reason = run.failure || (closing
        ? { code: 'RUNTIME_CLOSED', message: 'Runtime is closed' }
        : { code: run.readyAt ? 'AGENT_EXITED' : 'AGENT_START_FAILED', message: 'System Agent exited' });
      run.failure = reason;
      for (const [id, entry] of pending) {
        settle(id, entry.timeout ? failure(id, 'TIMEOUT', 'System Agent request timed out') : failure(id, reason.code, reason.message));
      }
      run.resolveExit();
    }

    run.child.once('exit', onExit);
    run.child.on('error', () => {
      if (!run.child.pid) {
        run.failure = { code: 'AGENT_START_FAILED', message: 'Unable to start System Agent' };
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
      if (message.type === 'ready' && state === 'STARTING') {
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
    run.startupTimer = setTimeout(() => failRun(run, 'AGENT_START_FAILED', 'System Agent startup timed out'), startupTimeoutMs);
    send(run, { version: 1, type: 'initialize', instanceId: run.instanceId });
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
        // A spawned process failure is settled on exit, never merely on signal delivery.
        if (!current || current.exited) settle(requestId, failure(requestId, 'AGENT_START_FAILED', 'Unable to start System Agent'));
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
        clearTimeout(run.startupTimer);
        run.rejectStart(new Error('Runtime is closed'));
        if (!run.terminationPromise) {
          send(run, { version: 1, type: 'shutdown', instanceId: run.instanceId });
          const graceTimer = setTimeout(() => { void terminate(run); }, terminationGraceMs);
          await run.exitPromise;
          clearTimeout(graceTimer);
        } else {
          await run.exitPromise;
        }
      }
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
    };
  }

  return { start, request, close, getAgentMetadata };
}

module.exports = { createOrchestrator };
