const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { once } = require('node:events');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { createOrchestrator } = require('../src/core/orchestrator');
const { ResourceSetupError } = require('../src/core/resource-manager');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeManager(overrides = {}) {
  return {
    inspect: () => ({ enforcing: false }),
    prepare: (instanceId, policy) => ({ instanceId, enforcementStatus: policy.mode }),
    attach() {},
    snapshot: () => ({ enforcing: false, usage: 123 }),
    dispose() {},
    ...overrides,
  };
}

function runtimeFor(t, manager, options = {}) {
  const runtime = createOrchestrator({ resourceManager: manager, terminationGraceMs: 40, ...options });
  t.after(() => runtime.close());
  return runtime;
}

function captureChild(t, onSend = () => {}) {
  const spawned = deferred();
  const originalFork = childProcess.fork;
  t.mock.method(childProcess, 'fork', (...args) => {
    const child = originalFork(...args);
    const send = child.send.bind(child);
    child.send = (message, ...rest) => { onSend(message); return send(message, ...rest); };
    spawned.resolve(child);
    return child;
  });
  return spawned.promise;
}

test('default control is disabled and observation stays in supervisor metadata', async (t) => {
  const runtime = runtimeFor(t, undefined);
  assert.equal(runtime.getAgentMetadata().resources.enforcementStatus, 'disabled');
  assert.equal((await runtime.request('get_system_info')).status, 'success');
  await runtime.close();
  assert.equal(runtime.getAgentMetadata().resources.latestSnapshot, null);
  const observed = runtimeFor(t, undefined, { resourcePolicy: { mode: 'observe' } });
  const response = await observed.request('get_system_info');
  assert.equal(response.status, 'success');
  assert.equal('resources' in response.data, false);
  assert.equal(observed.getAgentMetadata().resources.enforcementStatus, 'observe');
  assert.equal(observed.getAgentMetadata().resources.capabilities.enforcing, false);
  await observed.close();
  assert.equal(observed.getAgentMetadata().resources.latestSnapshot.enforcing, false);
});

test('prepare precedes spawn and attach completes before initialize', async (t) => {
  const preparation = deferred();
  const attachment = deferred();
  t.after(() => { preparation.resolve(); attachment.resolve(); });
  const events = [];
  const childPromise = captureChild(t, ({ type }) => { if (type === 'initialize') events.push(type); });
  const runtime = runtimeFor(t, fakeManager({
    prepare(instanceId) { events.push('prepare'); return preparation.promise.then(() => ({ instanceId, enforcementStatus: 'disabled' })); },
    attach(allocation, pid) { assert.ok(pid > 0); events.push('attach'); return attachment.promise; },
  }));
  const startup = runtime.start();
  assert.deepEqual(events, ['prepare']);
  assert.equal(runtime.getAgentMetadata().pid, null);
  preparation.resolve();
  await childPromise;
  assert.deepEqual(events, ['prepare', 'attach']);
  assert.equal(runtime.getAgentMetadata().state, 'STARTING');
  attachment.resolve();
  await startup;
  assert.deepEqual(events, ['prepare', 'attach', 'initialize']);
});

for (const phase of ['prepare', 'attach']) {
  for (const asynchronous of [false, true]) {
    test(`${phase} failure (async=${asynchronous}) prevents initialization and cleans up`, async (t) => {
      const events = [];
      let disposed = 0;
      captureChild(t, ({ type }) => events.push(type));
      const runtime = runtimeFor(t, fakeManager({
        [phase]() {
          const error = Object.assign(new Error('Injected failure'), { code: 'RESOURCE_DENIED' });
          if (asynchronous) return Promise.reject(error);
          throw error;
        },
        dispose() { disposed++; },
      }));
      const response = await runtime.request('get_system_info');
      assert.equal(response.error.code, 'RESOURCE_DENIED');
      assert.equal(events.includes('initialize'), false);
      assert.equal(disposed, phase === 'prepare' ? 0 : 1);
      assert.equal(runtime.getAgentMetadata().resources.setupError.phase, phase);
      if (phase === 'attach') assert.throws(() => process.kill(runtime.getAgentMetadata().pid, 0), { code: 'ESRCH' });
      await runtime.close();
    });
  }
}

for (const phase of ['prepare', 'attach']) {
  test(`startup timeout covers pending ${phase} and disposes late allocation`, async (t) => {
    const gate = deferred();
    t.after(() => gate.resolve());
    let disposed = 0;
    let initialized = false;
    let setupSignal;
    const spawned = captureChild(t, ({ type }) => { if (type === 'initialize') initialized = true; });
    const manager = fakeManager({
      [phase](instanceId, policyOrPid, { signal }) {
        setupSignal = signal;
        return gate.promise.then(() => phase === 'prepare' ? { instanceId, enforcementStatus: 'disabled' } : undefined);
      },
      dispose() { disposed++; },
    });
    const runtime = runtimeFor(t, manager, { startupTimeoutMs: 100 });
    const startup = runtime.start();
    await assert.rejects(startup, { code: 'AGENT_START_FAILED' });
    assert.equal(setupSignal.aborted, true);
    assert.equal(runtime.getAgentMetadata().state, 'STOPPING');
    assert.equal(runtime.getAgentMetadata().resources.setupError.phase, phase);
    if (phase === 'attach') {
      const child = await spawned;
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    }
    let closed = false;
    const closing = runtime.close().then(() => { closed = true; });
    await Promise.resolve();
    assert.equal(closed, false);
    gate.resolve();
    await closing;
    assert.equal(disposed, 1);
    assert.equal(initialized, false);
    assert.equal(runtime.getAgentMetadata().resources.enforcementStatus, 'unavailable');
  });
}

for (const phase of ['prepare', 'attach']) {
  test(`close during ${phase} waits for setup and prevents initialization`, async (t) => {
    const gate = deferred();
    t.after(() => gate.resolve());
    let disposed = 0;
    let initialized = false;
    let setupSignal;
    const spawned = captureChild(t, ({ type }) => { if (type === 'initialize') initialized = true; });
    const runtime = runtimeFor(t, fakeManager({
      [phase](instanceId, policyOrPid, { signal }) {
        setupSignal = signal;
        return gate.promise.then(() => phase === 'prepare' ? { instanceId, enforcementStatus: 'observe' } : undefined);
      },
      dispose() { disposed++; },
    }), { resourcePolicy: { mode: 'observe' } });
    const startup = runtime.start();
    if (phase === 'attach') await spawned;
    const rejection = assert.rejects(startup, /closed/);
    let closed = false;
    const closing = runtime.close().then(() => { closed = true; });
    assert.equal(setupSignal.aborted, true);
    await rejection;
    assert.equal(closed, false);
    gate.resolve();
    await closing;
    assert.equal(disposed, 1);
    assert.equal(initialized, false);
    assert.equal(runtime.getAgentMetadata().state, 'CLOSED');
    assert.equal(runtime.getAgentMetadata().resources.enforcementStatus, 'cancelled');
  });
}

test('child exit takes a final snapshot and restart waits for prior disposal', async (t) => {
  const disposal = deferred();
  t.after(() => disposal.resolve());
  const disposing = deferred();
  const events = [];
  const childPromise = captureChild(t);
  const runtime = runtimeFor(t, fakeManager({
    prepare(instanceId) { events.push('prepare'); return { instanceId, enforcementStatus: 'disabled' }; },
    snapshot() { events.push('snapshot'); return { enforcing: false, usage: 456 }; },
    dispose() { events.push('dispose'); disposing.resolve(); return disposal.promise; },
  }));
  await runtime.start();
  const original = runtime.getAgentMetadata();
  const child = await childPromise;
  child.kill('SIGKILL');
  await disposing.promise;
  let restarted = false;
  const restart = runtime.start().then(() => { restarted = true; });
  await Promise.resolve();
  assert.equal(restarted, false);
  assert.equal(runtime.getAgentMetadata().instanceId, original.instanceId);
  assert.deepEqual(events, ['prepare', 'snapshot', 'dispose']);
  assert.deepEqual(runtime.getAgentMetadata().resources.latestSnapshot, { enforcing: false, usage: 456 });
  disposal.resolve();
  await restart;
  assert.notEqual(runtime.getAgentMetadata().instanceId, original.instanceId);
  assert.equal(events.filter((event) => event === 'prepare').length, 2);
});

test('snapshot failure still disposes; disposal failure is observable and blocks restart', async (t) => {
  let disposed = 0;
  const runtime = runtimeFor(t, fakeManager({
    snapshot() { throw new Error('Snapshot failed'); },
    dispose() { disposed++; throw Object.assign(new Error('Disposal failed'), { code: 'EBUSY' }); },
  }));
  await runtime.start();
  await runtime.close();
  assert.equal(disposed, 1);
  const metadata = runtime.getAgentMetadata();
  assert.equal(metadata.resources.cleanupStatus, 'failed');
  assert.deepEqual(metadata.resources.cleanupErrors.map(({ phase }) => phase), ['snapshot', 'dispose']);
  assert.equal(metadata.resources.disposalFailed, true);
  metadata.resources.cleanupErrors[0].message = 'changed';
  assert.equal(runtime.getAgentMetadata().resources.cleanupErrors[0].message, 'Snapshot failed');

  const childPromise = captureChild(t);
  const failed = runtimeFor(t, fakeManager({ dispose() { throw new Error('Cannot dispose'); } }));
  await failed.start();
  const child = await childPromise;
  child.kill('SIGKILL');
  await once(child, 'exit');
  await assert.rejects(failed.start(), { code: 'RESOURCE_CLEANUP_FAILED' });
  assert.equal(failed.getAgentMetadata().state, 'FAILED');
});

test('requested enforcement fails explicitly with policy and discovery metadata', async (t) => {
  const policy = { mode: 'enforce', memoryMaxBytes: 1048576, cpuQuotaMicros: 50000, pidsMax: 16 };
  const runtime = runtimeFor(t, undefined, { resourcePolicy: policy });
  policy.memoryMaxBytes = 1;
  const response = await runtime.request('get_system_info');
  assert.equal(response.error.code, 'RESOURCE_ENFORCEMENT_UNAVAILABLE');
  await runtime.close();
  const resources = runtime.getAgentMetadata().resources;
  assert.equal(resources.requestedPolicy.memoryMaxBytes, 1048576);
  assert.equal(resources.requestedPolicy.cpuPeriodMicros, 100000);
  assert.equal(resources.enforcementStatus, 'unavailable');
  assert.equal(resources.capabilities.enforcementAvailable, false);
  assert.equal(runtime.getAgentMetadata().pid, null);
});

test('late attachment rejection retains the original timeout and disposes exactly once', async (t) => {
  const attachment = deferred();
  t.after(() => attachment.resolve());
  let disposed = 0;
  const runtime = runtimeFor(t, fakeManager({
    attach: () => attachment.promise,
    dispose() { disposed++; },
  }), { startupTimeoutMs: 100 });
  await assert.rejects(runtime.start(), { code: 'AGENT_START_FAILED' });
  attachment.reject(Object.assign(new Error('Late failure'), { code: 'LATE_ATTACH_FAILURE' }));
  await runtime.close();
  assert.equal(disposed, 1);
  assert.equal(runtime.getAgentMetadata().terminationReason, 'AGENT_START_FAILED');
  assert.equal(runtime.getAgentMetadata().resources.setupError.code, 'AGENT_START_FAILED');
});

test('snapshot failure remains observable while successful disposal permits restart', async (t) => {
  const childPromise = captureChild(t);
  const runtime = runtimeFor(t, fakeManager({ snapshot() { throw new Error('No final counters'); } }));
  await runtime.start();
  const child = await childPromise;
  child.kill('SIGKILL');
  await once(child, 'exit');
  const restarting = runtime.start();
  // Cleanup may already be running; it must finish before a new preparation.
  await restarting;
  assert.equal(runtime.getAgentMetadata().state, 'READY');
  await runtime.close();
  assert.equal(runtime.getAgentMetadata().resources.cleanupErrors[0].phase, 'snapshot');
  assert.equal(runtime.getAgentMetadata().resources.disposalFailed, false);
});

test('an injected manager cannot silently downgrade an enforcement request', async (t) => {
  let disposed = false;
  const runtime = runtimeFor(t, fakeManager({
    prepare: () => ({ enforcementStatus: 'observe' }), dispose() { disposed = true; },
  }), { resourcePolicy: { mode: 'enforce', pidsMax: 16 } });
  assert.equal((await runtime.request('get_system_info')).error.code, 'RESOURCE_ENFORCEMENT_UNAVAILABLE');
  await runtime.close();
  assert.equal(disposed, true);
});

test('invalid manager or policy is rejected before spawning', () => {
  assert.throws(() => createOrchestrator({ resourceManager: {} }), TypeError);
  assert.throws(() => createOrchestrator({ resourcePolicy: { mode: 'disabled', memoryMaxBytes: 1024 } }), TypeError);
});

// Simulate event orderings that the OS does not reliably reproduce on demand.
// These PIDs are never passed to process.kill or any cgroup operation.
function simulatedChild(t, { pid = 1234, ready = true } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  const messages = [];
  child.send = (message, callback) => {
    messages.push(message.type);
    callback?.();
    if (message.type === 'initialize' && ready) {
      queueMicrotask(() => child.emit('message', { version: 1, type: 'ready', instanceId: message.instanceId }));
    }
    if (message.type === 'request') child.emit('request-sent');
    if (message.type === 'shutdown') queueMicrotask(() => child.emit('exit', 0, null));
  };
  child.kill = () => { queueMicrotask(() => child.emit('exit', null, 'SIGTERM')); return true; };
  t.mock.method(childProcess, 'fork', () => child);
  return { child, messages };
}

for (const startupWaiter of [false, true]) {
  test(`exit freezes request deadlines through slow disposal (startup=${startupWaiter})`, async (t) => {
    const disposal = deferred();
    const disposing = deferred();
    t.after(() => disposal.resolve());
    const { child } = simulatedChild(t, { ready: !startupWaiter });
    const runtime = runtimeFor(t, fakeManager({ dispose() { disposing.resolve(); return disposal.promise; } }));
    if (!startupWaiter) await runtime.start();
    const dispatched = startupWaiter ? null : once(child, 'request-sent');
    let settled = false;
    const response = runtime.request('get_system_info', 20).then((value) => { settled = true; return value; });
    if (dispatched) await dispatched;
    child.emit('exit', 7, null); // Exit precedes any disconnect or deadline event.
    await disposing.promise;
    await delay(40);
    assert.equal(settled, false);
    disposal.resolve();
    assert.equal((await response).error.code, startupWaiter ? 'AGENT_START_FAILED' : 'AGENT_EXITED');
  });
}

test('a genuine pre-exit request timeout survives slow resource cleanup', async (t) => {
  const disposal = deferred();
  const disposing = deferred();
  t.after(() => disposal.resolve());
  simulatedChild(t);
  const runtime = runtimeFor(t, fakeManager({ dispose() { disposing.resolve(); return disposal.promise; } }));
  await runtime.start();
  const response = runtime.request('get_system_info', 20);
  await disposing.promise; // Request timeout caused termination and exit.
  assert.equal(runtime.getAgentMetadata().terminationReason, 'AGENT_TERMINATED');
  disposal.resolve();
  assert.equal((await response).error.code, 'TIMEOUT');
});

for (const disposalFails of [false, true]) {
  test(`failed prepare transfers partial allocation (disposal fails=${disposalFails})`, async (t) => {
    const allocation = { path: 'logical-only', enforcementStatus: 'observe' };
    const disposing = deferred();
    const disposal = deferred();
    t.after(() => disposal.resolve());
    let attempts = 0;
    const runtime = runtimeFor(t, fakeManager({
      prepare() {
        throw new ResourceSetupError(Object.assign(new Error('Configuration failed'), { code: 'CONFIG_FAILED' }), {
          allocation, rollbackError: Object.assign(new Error('Rollback failed'), { code: 'EBUSY' }),
        });
      },
      snapshot(handle) { assert.equal(handle, allocation); return null; },
      async dispose(handle) {
        assert.equal(handle, allocation);
        attempts++;
        disposing.resolve();
        await disposal.promise;
        if (disposalFails) throw Object.assign(new Error('Supervisor disposal failed'), { code: 'EACCES' });
      },
    }), { resourcePolicy: { mode: 'observe' } });
    await assert.rejects(runtime.start(), { code: 'RESOURCE_SETUP_FAILED' });
    await disposing.promise;
    assert.equal(runtime.getAgentMetadata().state, 'STOPPING');
    assert.equal(runtime.getAgentMetadata().resources.cleanupStatus, 'running');
    const retry = runtime.start();
    const retryRejection = assert.rejects(retry, { code: disposalFails ? 'RESOURCE_CLEANUP_FAILED' : 'RESOURCE_SETUP_FAILED' });
    disposal.resolve();
    await retryRejection;
    await runtime.close();
    const resources = runtime.getAgentMetadata().resources;
    assert.equal(resources.setupError.originalError.code, 'CONFIG_FAILED');
    assert.ok(resources.cleanupErrors.some(({ phase, code }) => phase === 'rollback' && code === 'EBUSY'));
    assert.equal(resources.disposalFailed, disposalFails);
    assert.equal(resources.cleanupStatus, disposalFails ? 'failed' : 'complete');
    assert.equal(attempts, disposalFails ? 1 : 2);
    if (disposalFails) assert.ok(resources.cleanupErrors.some(({ phase }) => phase === 'dispose'));
  });
}

test('typed prepare failure without an allocation requires no disposal', async (t) => {
  let attempts = 0;
  const runtime = runtimeFor(t, fakeManager({
    prepare() { throw new ResourceSetupError(new Error('No allocation created')); },
    dispose() { attempts++; },
  }));
  await assert.rejects(runtime.start(), { code: 'RESOURCE_SETUP_FAILED' });
  await runtime.close();
  assert.equal(attempts, 0);
  assert.equal(runtime.getAgentMetadata().resources.cleanupStatus, 'complete');
  assert.throws(() => new ResourceSetupError(new Error('Setup failed'), { rollbackError: new Error('Rollback failed') }), TypeError);
});

test('late typed prepare rejection after close still transfers ownership and cleanup failure', async (t) => {
  const preparation = deferred();
  t.after(() => preparation.resolve({ enforcementStatus: 'observe' }));
  const allocation = { enforcementStatus: 'observe' };
  let disposed = 0;
  const runtime = runtimeFor(t, fakeManager({
    prepare: () => preparation.promise,
    dispose(handle) {
      assert.equal(handle, allocation);
      disposed++;
      return Promise.reject(Object.assign(new Error('Still owned'), { code: 'EBUSY' }));
    },
  }), { resourcePolicy: { mode: 'observe' } });
  const rejected = assert.rejects(runtime.start(), /closed/);
  const closing = runtime.close();
  preparation.reject(new ResourceSetupError(new Error('Aborted during configuration'), {
    allocation, rollbackError: new Error('Rollback could not release allocation'),
  }));
  await Promise.all([rejected, closing]);
  const resources = runtime.getAgentMetadata().resources;
  assert.equal(disposed, 1);
  assert.equal(resources.enforcementStatus, 'cancelled');
  assert.equal(resources.cleanupStatus, 'failed');
  assert.equal(resources.disposalFailed, true);
  assert.deepEqual(resources.cleanupErrors.map(({ phase }) => phase), ['rollback', 'dispose']);
});

for (const outcome of ['success', 'reject', 'timeout-late-success', 'timeout-late-reject', 'never-settles']) {
  test(`final snapshot ${outcome} cannot prevent authoritative disposal`, async (t) => {
    const observation = deferred();
    simulatedChild(t);
    let disposed = 0;
    const runtime = runtimeFor(t, fakeManager({
      snapshot() {
        if (outcome === 'success') return Promise.resolve({ usage: 99 });
        if (outcome === 'reject') return Promise.reject(Object.assign(new Error('Observation failed'), { code: 'READ_FAILED' }));
        return observation.promise;
      },
      dispose() { disposed++; },
    }), { resourceSnapshotTimeoutMs: 20 });
    await runtime.start();
    await runtime.close();
    assert.equal(disposed, 1);
    const resources = runtime.getAgentMetadata().resources;
    if (outcome === 'success') {
      assert.deepEqual(resources.latestSnapshot, { usage: 99 });
      assert.deepEqual(resources.cleanupErrors, []);
    } else {
      assert.equal(resources.cleanupErrors[0].phase, 'snapshot');
      assert.equal(resources.cleanupErrors[0].code, outcome === 'reject' ? 'READ_FAILED' : 'RESOURCE_SNAPSHOT_TIMEOUT');
    }
    assert.equal(resources.disposalFailed, false);
    if (outcome === 'timeout-late-success') observation.resolve({ usage: 999 });
    if (outcome === 'timeout-late-reject') observation.reject(new Error('Late observation rejection'));
    await delay(0);
    assert.deepEqual(runtime.getAgentMetadata().resources, resources);
  });
}

for (const lateOutcome of ['success', 'reject']) {
  test(`unexpected exit during attachment owns late ${lateOutcome}`, async (t) => {
    const attachment = deferred();
    t.after(() => attachment.resolve());
    const { child, messages } = simulatedChild(t);
    let disposed = 0;
    let setupSignal;
    const runtime = runtimeFor(t, fakeManager({
      attach(allocation, pid, { signal }) { setupSignal = signal; return attachment.promise; },
      dispose() { disposed++; },
    }));
    const rejection = assert.rejects(runtime.start(), /exited before readiness/);
    child.emit('exit', 7, null);
    await rejection;
    assert.equal(setupSignal.aborted, true);
    assert.equal(disposed, 0);
    assert.equal(runtime.getAgentMetadata().state, 'STOPPING');
    if (lateOutcome === 'success') attachment.resolve();
    else attachment.reject(new Error('Late attach rejection'));
    await runtime.close();
    assert.equal(disposed, 1);
    assert.equal(messages.includes('initialize'), false);
    assert.equal(runtime.getAgentMetadata().terminationReason, 'AGENT_START_FAILED');
    assert.equal(runtime.getAgentMetadata().resources.enforcementStatus, 'unavailable');
    if (lateOutcome === 'reject') assert.equal(runtime.getAgentMetadata().resources.setupError.phase, 'attach');
  });
}

test('synchronous fork failure disposes an already prepared allocation', async (t) => {
  t.mock.method(childProcess, 'fork', () => { throw new Error('Fork failed'); });
  let disposed = 0;
  let attached = false;
  const runtime = runtimeFor(t, fakeManager({ attach() { attached = true; }, dispose() { disposed++; } }));
  assert.equal((await runtime.request('get_system_info')).error.code, 'AGENT_START_FAILED');
  await runtime.close();
  assert.equal(attached, false);
  assert.equal(disposed, 1);
});

test('asynchronous spawn failure without a PID never calls attach or initialize', async (t) => {
  const { child, messages } = simulatedChild(t, { pid: null });
  let disposed = 0;
  let attached = false;
  const runtime = runtimeFor(t, fakeManager({ attach() { attached = true; }, dispose() { disposed++; } }));
  const startup = runtime.start();
  const rejected = assert.rejects(startup, /exited before readiness/);
  queueMicrotask(() => child.emit('error', Object.assign(new Error('Spawn failed'), { code: 'ENOENT' })));
  await rejected;
  await runtime.close();
  assert.equal(attached, false);
  assert.equal(messages.includes('initialize'), false);
  assert.equal(disposed, 1);
  assert.equal(runtime.getAgentMetadata().terminationReason, 'AGENT_START_FAILED');
});

for (const closeWhileWaiting of [false, true]) {
  test(`restart callers share cleanup barrier (close=${closeWhileWaiting})`, async (t) => {
    const disposal = deferred();
    const disposing = deferred();
    t.after(() => disposal.resolve());
    const { child } = simulatedChild(t);
    let prepared = 0;
    const runtime = runtimeFor(t, fakeManager({
      prepare(instanceId) { prepared++; return { instanceId, enforcementStatus: 'disabled' }; },
      dispose() { disposing.resolve(); return disposal.promise; },
    }));
    await runtime.start();
    child.emit('exit', 7, null);
    await disposing.promise;
    const first = runtime.start();
    const second = runtime.start();
    assert.equal(prepared, 1);
    if (closeWhileWaiting) {
      const rejections = Promise.all([assert.rejects(first, /closed/), assert.rejects(second, /closed/)]);
      const closing = runtime.close();
      disposal.resolve();
      await Promise.all([closing, rejections]);
      assert.equal(prepared, 1);
      assert.equal(runtime.getAgentMetadata().state, 'CLOSED');
    } else {
      disposal.resolve();
      await Promise.all([first, second]);
      assert.equal(prepared, 2);
      assert.equal(runtime.getAgentMetadata().state, 'READY');
    }
  });
}

test('snapshot timeout does not release an unresolved disposal barrier', async (t) => {
  const disposal = deferred();
  const disposing = deferred();
  t.after(() => disposal.resolve());
  const { child } = simulatedChild(t);
  const runtime = runtimeFor(t, fakeManager({
    snapshot: () => new Promise(() => {}),
    dispose() { disposing.resolve(); return disposal.promise; },
  }), { resourceSnapshotTimeoutMs: 20 });
  await runtime.start();
  child.emit('exit', 7, null);
  await disposing.promise;
  let restarted = false;
  const restart = runtime.start().then(() => { restarted = true; });
  await Promise.resolve();
  assert.equal(restarted, false);
  assert.equal(runtime.getAgentMetadata().resources.cleanupStatus, 'running');
  disposal.resolve();
  await restart;
});

test('snapshot timeout configuration is validated before spawning', () => {
  for (const resourceSnapshotTimeoutMs of [0, -1, 0.5, Infinity, '20']) {
    assert.throws(() => createOrchestrator({ resourceSnapshotTimeoutMs }), TypeError);
  }
});
