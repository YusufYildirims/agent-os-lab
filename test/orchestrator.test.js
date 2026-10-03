const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { createOrchestrator } = require('../src/core/orchestrator');

function runtimeFor(t, mode) {
  if (mode) {
    const original = process.env.AGENT_TEST_MODE;
    process.env.AGENT_TEST_MODE = mode;
    t.after(() => {
      if (original === undefined) delete process.env.AGENT_TEST_MODE;
      else process.env.AGENT_TEST_MODE = original;
    });
  }
  const runtime = createOrchestrator(mode ? {
    agentPath: require.resolve('./fixtures/agent.cjs'), terminationGraceMs: 40,
  } : {});
  t.after(() => runtime.close());
  return runtime;
}

function assertDead(pid) {
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

test('real IPC isolates the agent and reuses its process', async (t) => {
  const runtime = runtimeFor(t);
  const first = await runtime.request('get_system_info');
  assert.equal(first.status, 'success');
  const initial = runtime.getAgentMetadata();
  assert.notEqual(initial.pid, process.pid);
  assert.equal(initial.orchestratorPid, process.pid);
  const status = await readFile(`/proc/${initial.pid}/status`, 'utf8');
  assert.match(status, new RegExp(`PPid:\\s+${process.pid}\\n`));
  const second = await runtime.request('get_system_info');
  assert.equal(second.status, 'success');
  assert.notEqual(first.requestId, second.requestId);
  assert.equal(runtime.getAgentMetadata().pid, initial.pid);
  assert.equal(runtime.getAgentMetadata().instanceId, initial.instanceId);
  await runtime.close();
  assertDead(initial.pid);
});

test('invalid requests are rejected without starting a child', async (t) => {
  const runtime = runtimeFor(t);
  for (const timeout of [0, -1, 0.5, NaN, Infinity, '1000', null, 2147483648]) {
    assert.equal((await runtime.request('get_system_info', timeout)).error.code, 'INVALID_REQUEST');
  }
  assert.equal((await runtime.request('shell')).error.code, 'INVALID_REQUEST');
  assert.equal(runtime.getAgentMetadata().pid, null);
});

test('concurrent callers share startup and match out-of-order request IDs', async (t) => {
  const runtime = runtimeFor(t, 'reorder');
  const completions = [];
  const firstPromise = runtime.request('get_system_info').then((r) => { completions.push(1); return r; });
  const secondPromise = runtime.request('get_system_info').then((r) => { completions.push(2); return r; });
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(first.data.hostname, 'request-1');
  assert.equal(second.data.hostname, 'request-2');
  assert.notEqual(first.requestId, second.requestId);
  assert.deepEqual(completions, [2, 1]);
  assert.equal(runtime.getAgentMetadata().pendingRequestCount, 0);
});

for (const mode of ['hang', 'ignore-term']) {
  test(`timeout confirms exit (${mode}) and fails peer requests`, async (t) => {
    const runtime = runtimeFor(t, mode);
    await runtime.start();
    const pid = runtime.getAgentMetadata().pid;
    const [response, peer] = await Promise.all([
      runtime.request('get_system_info', 30), runtime.request('get_system_info', 1000),
    ]);
    assert.equal(response.error.code, 'TIMEOUT');
    assert.equal(peer.error.code, 'AGENT_TERMINATED');
    assertDead(pid);
    assert.equal(runtime.getAgentMetadata().state, 'FAILED');
    if (mode === 'ignore-term') assert.equal(runtime.getAgentMetadata().signalCode, 'SIGKILL');
    assert.equal((await runtime.request('get_system_info')).error.code, 'AGENT_UNAVAILABLE');
  });
}

for (const mode of ['crash', 'disconnect', 'malformed']) {
  test(`supervisor handles ${mode} and confirms cleanup`, async (t) => {
    const runtime = runtimeFor(t, mode);
    await runtime.start();
    const pid = runtime.getAgentMetadata().pid;
    const responses = await Promise.all([runtime.request('get_system_info'), runtime.request('get_system_info')]);
    for (const response of responses) {
      assert.equal(response.status, 'error');
      assert.ok(['AGENT_EXITED', 'AGENT_DISCONNECTED', 'PROTOCOL_ERROR'].includes(response.error.code));
    }
    assertDead(pid);
    assert.equal(runtime.getAgentMetadata().pendingRequestCount, 0);
    assert.equal(runtime.getAgentMetadata().terminationReason, responses[0].error.code);
    if (mode === 'crash') assert.equal(runtime.getAgentMetadata().exitCode, 7);
  });
}

test('clean shutdown settles pending work, is idempotent, and prevents reuse', async (t) => {
  const runtime = runtimeFor(t, 'hang');
  await runtime.start();
  const pid = runtime.getAgentMetadata().pid;
  const pending = runtime.request('get_system_info');
  const closing = runtime.close();
  assert.equal(runtime.close(), closing);
  assert.equal((await pending).error.code, 'RUNTIME_CLOSED');
  await closing;
  assertDead(pid);
  assert.equal(runtime.getAgentMetadata().state, 'CLOSED');
  assert.equal((await runtime.request('get_system_info')).error.code, 'RUNTIME_CLOSED');
  await assert.rejects(runtime.start(), /closed/);
});

test('explicit restart after a crash creates a new instance', async (t) => {
  const runtime = runtimeFor(t, 'crash');
  await runtime.start();
  const old = runtime.getAgentMetadata();
  await runtime.request('get_system_info');
  await runtime.start();
  const next = runtime.getAgentMetadata();
  assert.notEqual(next.pid, old.pid);
  assert.notEqual(next.instanceId, old.instanceId);
});

test('missing entrypoint fails startup without leaving a child', async (t) => {
  const runtime = createOrchestrator({ agentPath: '/tmp/agent-os-missing-entrypoint.cjs' });
  t.after(() => runtime.close());
  assert.equal((await runtime.request('get_system_info')).status, 'error');
  assertDead(runtime.getAgentMetadata().pid);
});

test('shutdown during startup leaves no process behind', async (t) => {
  const runtime = runtimeFor(t);
  const response = runtime.request('get_system_info');
  const pid = runtime.getAgentMetadata().pid;
  await runtime.close();
  assert.equal((await response).error.code, 'RUNTIME_CLOSED');
  assertDead(pid);
});

test('startup timeout terminates an unready child', async (t) => {
  const runtime = createOrchestrator({
    agentPath: require.resolve('./fixtures/unready.cjs'), startupTimeoutMs: 100,
    terminationGraceMs: 40,
  });
  t.after(() => runtime.close());
  const response = await runtime.request('get_system_info', 1000);
  assert.equal(response.error.code, 'AGENT_START_FAILED');
  assertDead(runtime.getAgentMetadata().pid);
});

test('constructor validates paths and deadline configuration', () => {
  for (const options of [null, [], 42, 'options', false]) {
    assert.throws(() => createOrchestrator(options), TypeError);
  }
  for (const key of ['startupTimeoutMs', 'terminationGraceMs']) {
    for (const value of [0, -1, 0.5, NaN, Infinity, '100', null, 2147483648]) {
      assert.throws(() => createOrchestrator({ [key]: value }), TypeError);
    }
  }
  for (const agentPath of ['', './relative.cjs', null, 42, '/tmp/invalid\0.cjs']) {
    assert.throws(() => createOrchestrator({ agentPath }), TypeError);
  }
});

test('admission limit includes startup waiters and rejects request 65', async (t) => {
  const runtime = runtimeFor(t, 'slow-ready');
  const requests = Array.from({ length: 64 }, () => runtime.request('get_system_info'));
  assert.equal(runtime.getAgentMetadata().pendingRequestCount, 64);
  assert.equal((await runtime.request('get_system_info')).error.code, 'AGENT_BUSY');
  assert.equal(runtime.getAgentMetadata().pendingRequestCount, 64);
  await runtime.close();
  for (const response of await Promise.all(requests)) assert.equal(response.error.code, 'RUNTIME_CLOSED');
  assert.equal(runtime.getAgentMetadata().pendingRequestCount, 0);
});

test('timeout before dispatch leaves startup alive and does not execute expired work', async (t) => {
  const runtime = runtimeFor(t, 'slow-ready');
  const response = await runtime.request('get_system_info', 10);
  assert.equal(response.error.code, 'TIMEOUT');
  assert.equal(runtime.getAgentMetadata().state, 'STARTING');
  const pid = runtime.getAgentMetadata().pid;
  await runtime.start();
  const next = await runtime.request('get_system_info');
  assert.equal(next.data.hostname, 'request-1');
  assert.equal(runtime.getAgentMetadata().pid, pid);
  assert.equal(runtime.getAgentMetadata().terminationReason, null);
});

test('wrong-instance response fails the process and records protocol failure', async (t) => {
  const runtime = runtimeFor(t, 'wrong-instance');
  const response = await runtime.request('get_system_info');
  assert.equal(response.error.code, 'PROTOCOL_ERROR');
  const metadata = runtime.getAgentMetadata();
  assert.equal(metadata.terminationReason, 'PROTOCOL_ERROR');
  assert.equal(metadata.state, 'FAILED');
  assertDead(metadata.pid);
});

test('valid duplicate and unknown responses do not poison subsequent requests', async (t) => {
  const runtime = runtimeFor(t, 'duplicates');
  const first = await runtime.request('get_system_info');
  const second = await runtime.request('get_system_info');
  assert.equal(first.data.hostname, 'request-1');
  assert.equal(second.data.hostname, 'request-2');
  assert.equal(runtime.getAgentMetadata().state, 'READY');
  assert.equal(runtime.getAgentMetadata().pendingRequestCount, 0);
});

test('close escalates through SIGTERM to SIGKILL for an uncooperative child', async (t) => {
  const runtime = runtimeFor(t, 'uncooperative');
  await runtime.start();
  const pid = runtime.getAgentMetadata().pid;
  const pending = runtime.request('get_system_info');
  await runtime.close();
  assert.equal((await pending).error.code, 'RUNTIME_CLOSED');
  assertDead(pid);
  const metadata = runtime.getAgentMetadata();
  assert.equal(metadata.signalCode, 'SIGKILL');
  assert.equal(metadata.terminationReason, 'RUNTIME_CLOSED');
  assert.equal(metadata.state, 'CLOSED');
});

// Fault injection wraps real children: cleanup must still observe an actual exit.
function interceptChild(t, intercept) {
  const childProcess = require('node:child_process');
  const originalFork = childProcess.fork;
  t.mock.method(childProcess, 'fork', (...args) => {
    const child = originalFork(...args);
    intercept(child);
    return child;
  });
}

for (const mode of ['callback', 'throw']) {
  test(`IPC send ${mode} failure terminates the real child`, async (t) => {
    interceptChild(t, (child) => {
      const originalSend = child.send.bind(child);
      child.send = (message, callback) => {
        if (message.type !== 'request') return originalSend(message, callback);
        const error = new Error('Injected send failure');
        if (mode === 'throw') throw error;
        queueMicrotask(() => callback(error));
        return false;
      };
    });
    const runtime = runtimeFor(t);
    const response = await runtime.request('get_system_info');
    assert.equal(response.error.code, 'AGENT_DISCONNECTED');
    assert.equal(runtime.getAgentMetadata().terminationReason, response.error.code);
    assertDead(runtime.getAgentMetadata().pid);
  });
}

for (const mode of ['false', 'throw']) {
  test(`failed SIGTERM (${mode}) records the error and escalates`, async (t) => {
    interceptChild(t, (child) => {
      const originalKill = child.kill.bind(child);
      child.kill = (signal) => {
        if (signal !== 'SIGTERM') return originalKill(signal);
        if (mode === 'false') return false;
        throw Object.assign(new Error('Denied'), { code: 'EPERM' });
      };
    });
    const runtime = runtimeFor(t, 'hang');
    await runtime.start();
    assert.equal((await runtime.request('get_system_info', 20)).error.code, 'TIMEOUT');
    const metadata = runtime.getAgentMetadata();
    assertDead(metadata.pid);
    assert.equal(metadata.signalCode, 'SIGKILL');
    assert.equal(metadata.terminationReason, 'AGENT_TERMINATED');
    assert.deepEqual(metadata.signalDeliveryErrors, [{ signal: 'SIGTERM', code: mode === 'false' ? 'SIGNAL_NOT_DELIVERED' : 'EPERM' }]);
    metadata.signalDeliveryErrors[0].code = 'changed';
    assert.notEqual(runtime.getAgentMetadata().signalDeliveryErrors[0].code, 'changed');
  });
}

for (const winner of ['response', 'timeout', 'close']) {
  test(`${winner} wins response/timeout/close race exactly once`, async (t) => {
    let child;
    let lastResponse;
    interceptChild(t, (spawned) => {
      child = spawned;
      child.on('message', (message) => {
        if (message.type === 'response') lastResponse = message;
      });
    });
    const runtime = runtimeFor(t, winner === 'response' ? 'reorder' : 'ignore-term');
    await runtime.start();
    let settlements = 0;
    const request = runtime.request('get_system_info', winner === 'timeout' ? 20 : 1000)
      .then((response) => { settlements++; return response; });
    if (winner === 'close') await runtime.close();
    const response = await request;
    if (winner === 'response') assert.equal(response.status, 'success');
    else assert.equal(response.error.code, winner === 'timeout' ? 'TIMEOUT' : 'RUNTIME_CLOSED');
    // A late response after settlement cannot settle again or resurrect the run.
    child.emit('message', lastResponse || {
      version: 1, type: 'response', instanceId: runtime.getAgentMetadata().instanceId,
      requestId: response.requestId, status: 'success',
      data: { hostname: 'late', kernelRelease: 'fixture', cpuCount: 1, totalMemoryBytes: 1, uptimeSeconds: 1 },
    });
    await runtime.close();
    assert.equal(settlements, 1);
    assert.equal(runtime.getAgentMetadata().pendingRequestCount, 0);
    assert.equal(runtime.getAgentMetadata().state, 'CLOSED');
    assertDead(runtime.getAgentMetadata().pid);
  });
}

for (const closeDuringTermination of [false, true]) {
  test(`late response during timeout cleanup is ignored (close=${closeDuringTermination})`, async (t) => {
    let child;
    let requestMessage;
    let termSent;
    const terminating = new Promise((resolve) => { termSent = resolve; });
    interceptChild(t, (spawned) => {
      child = spawned;
      const originalSend = child.send.bind(child);
      child.send = (message, callback) => {
        if (message.type === 'request') requestMessage = message;
        return originalSend(message, callback);
      };
      const originalKill = child.kill.bind(child);
      child.kill = (signal) => {
        if (signal === 'SIGTERM') {
          termSent();
          return false;
        }
        return originalKill(signal);
      };
    });
    const runtime = runtimeFor(t, 'ignore-term');
    await runtime.start();
    let settlements = 0;
    const request = runtime.request('get_system_info', 20).then((response) => {
      settlements++;
      return response;
    });
    await terminating;
    assert.equal(runtime.getAgentMetadata().state, 'STOPPING');
    child.emit('message', {
      ...requestMessage, type: 'response', status: 'success',
      data: { hostname: 'late', kernelRelease: 'fixture', cpuCount: 1, totalMemoryBytes: 1, uptimeSeconds: 1 },
    });
    assert.equal(settlements, 0);
    if (closeDuringTermination) await runtime.close();
    assert.equal((await request).error.code, closeDuringTermination ? 'RUNTIME_CLOSED' : 'TIMEOUT');
    assert.equal(settlements, 1);
    assert.equal(runtime.getAgentMetadata().terminationReason, 'AGENT_TERMINATED');
    await runtime.close();
    assertDead(runtime.getAgentMetadata().pid);
  });
}

test('failed SIGKILL retains ownership and waits for externally observed exit', { timeout: 5000 }, async (t) => {
  let actualKill;
  let killAttempted;
  const attempted = new Promise((resolve) => { killAttempted = resolve; });
  interceptChild(t, (child) => {
    actualKill = child.kill.bind(child);
    child.kill = (signal) => {
      if (signal === 'SIGKILL') killAttempted();
      throw Object.assign(new Error('Denied'), { code: 'EPERM' });
    };
  });
  // Register external cleanup before runtimeFor registers its exit-waiting hook.
  t.after(() => { if (actualKill) actualKill('SIGKILL'); });
  const runtime = runtimeFor(t, 'hang');
  await runtime.start();
  let settled = false;
  const response = runtime.request('get_system_info', 20).then((result) => { settled = true; return result; });
  await attempted;
  assert.equal(settled, false);
  assert.equal(runtime.getAgentMetadata().state, 'STOPPING');
  assert.deepEqual(runtime.getAgentMetadata().signalDeliveryErrors, [
    { signal: 'SIGTERM', code: 'EPERM' }, { signal: 'SIGKILL', code: 'EPERM' },
  ]);
  actualKill('SIGKILL');
  assert.equal((await response).error.code, 'TIMEOUT');
  assertDead(runtime.getAgentMetadata().pid);
});
