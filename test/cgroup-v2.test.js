const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cgroupFilesystem } = require('./fixtures/cgroup-filesystem.cjs');
const { createResourceManager, ResourceSetupError } = require('../src/core/resource-manager');
const { createOrchestrator } = require('../src/core/orchestrator');

function fixture() {
  const fixture = cgroupFilesystem();
  fixture.manager = createResourceManager({ filesystem: fixture.filesystem, delegatedBasePath: fixture.base });
  return fixture;
}
const prepare = (manager, instanceId = 'test-instance') => manager.prepare(instanceId, { mode: 'enforce' });

for (const [name, configure, blocker] of [
  ['missing base', (f) => f.dirs.delete(f.base), 'CGROUP_BASE_MISSING'],
  ['wrong filesystem', (f) => { f.filesystem.statfsSync = () => ({ type: 123 }); }, 'CGROUP_BASE_NOT_V2'],
  ['read-only mount', (f) => f.files.set('/proc/self/mountinfo', '10 1 0:24 / /cg ro - cgroup2 cgroup2 rw'), 'CGROUP_READ_ONLY'],
  ['not writable', (f) => { f.filesystem.accessSync = () => { throw f.fail('EACCES'); }; }, 'CGROUP_BASE_NOT_WRITABLE'],
  ['missing control', (f) => f.files.delete(`${f.base}/cgroup.events`), 'CGROUP_CONTROL_FILE_MISSING'],
  ['unavailable controller', (f) => f.files.set(`${f.base}/cgroup.controllers`, 'cpu memory'), 'CGROUP_CONTROLLER_UNAVAILABLE'],
  ['disabled controller', (f) => f.files.set(`${f.base}/cgroup.subtree_control`, 'cpu memory'), 'CGROUP_CONTROLLER_NOT_ENABLED'],
  ['threaded base', (f) => f.files.set(`${f.base}/cgroup.type`, 'threaded'), 'CGROUP_BASE_TOPOLOGY'],
  ['populated base itself', (f) => f.files.set(`${f.base}/cgroup.procs`, '100'), 'CGROUP_BASE_TOPOLOGY'],
  ['supervisor outside delegation', (f) => f.files.set('/proc/self/cgroup', '0::/non-systemd'), 'CGROUP_SOURCE_OUTSIDE_DELEGATION'],
  ['symlinked base', (f) => { f.filesystem.realpathSync = () => '/other/runtime'; }, 'CGROUP_PATH_UNSAFE'],
]) {
  test(`delegation rejects ${name} without mutation`, () => {
    const f = fixture();
    configure(f);
    const facts = f.manager.inspect();
    assert.equal(facts.allocationAvailable, false);
    assert.equal(facts.delegated.blockers[0].code, blocker);
    assert.throws(() => prepare(f.manager), { code: 'RESOURCE_ENFORCEMENT_UNAVAILABLE' });
    assert.deepEqual(f.mutations, []);
  });
}

test('base and instance traversal are rejected; global cgroup root is not delegation', () => {
  const f = fixture();
  for (const delegatedBasePath of ['relative', '/cg/runtime/../other', '/cg/runtime/./child', '/cg/runtime\0oops']) {
    const manager = createResourceManager({ filesystem: f.filesystem, delegatedBasePath });
    assert.equal(manager.inspect().delegated.blockers[0].code, 'CGROUP_BASE_PATH_INVALID');
  }
  const manager = createResourceManager({ filesystem: f.filesystem, delegatedBasePath: '/cg' });
  assert.equal(manager.inspect().delegated.blockers[0].code, 'CGROUP_BASE_NOT_DELEGATED');
  for (const instance of ['../escape', '/absolute', 'two/components', '..', '', 'nul\0', 'space name']) {
    assert.throws(() => prepare(f.manager, instance), { code: 'CGROUP_INSTANCE_INVALID' });
  }
  assert.deepEqual(f.mutations, []);
});

test('allocation creates unique owned leaves without controller writes or active limits', () => {
  const f = fixture();
  assert.equal(f.manager.inspect().allocationAvailable, true);
  assert.equal(f.manager.inspect().enforcementAvailable, false);
  const first = prepare(f.manager);
  const second = prepare(f.manager);
  assert.notEqual(first.path, second.path);
  assert.equal(path.dirname(first.path), f.base);
  assert.equal(first.enforcementStatus, 'allocated');
  assert.equal(first.capabilities.enforcing, false);
  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual(f.mutations.map(([operation]) => operation), ['mkdir', 'mkdir']);
  f.manager.dispose(first);
  f.manager.dispose(first); // Safe idempotent cleanup of the same allocation handle.
  f.manager.dispose(second);
  assert.equal(f.dirs.has(first.path), false);
});

test('explicit limits are rejected rather than silently ignored', () => {
  const f = fixture();
  for (const limits of [{ memoryMaxBytes: 1000 }, { cpuQuotaMicros: 10000 }, { pidsMax: 16 }]) {
    assert.throws(() => f.manager.prepare('limit-test', { mode: 'enforce', ...limits }), { code: 'RESOURCE_LIMITS_NOT_IMPLEMENTED' });
  }
  assert.deepEqual(f.mutations, []);
});

for (const rollbackFails of [false, true]) {
  test(`partially created allocation rolls back or transfers ownership (failure=${rollbackFails})`, (t) => {
    const f = fixture();
    const read = f.filesystem.readFileSync;
    let failed = false;
    t.mock.method(f.filesystem, 'readFileSync', (file, ...args) => {
      if (!failed && file.startsWith(`${f.base}/agent-`) && file.endsWith('/cgroup.type')) {
        failed = true;
        throw f.fail('EIO');
      }
      return read(file, ...args);
    });
    const rmdir = f.filesystem.rmdirSync;
    if (rollbackFails) t.mock.method(f.filesystem, 'rmdirSync', () => { throw f.fail('EBUSY'); });
    let rejected;
    try { prepare(f.manager); } catch (error) { rejected = error; }
    assert.ok(rejected instanceof ResourceSetupError);
    assert.equal(rejected.cause.code, 'EIO');
    if (rollbackFails) {
      assert.equal(rejected.rollbackError.code, 'EBUSY');
      assert.equal(f.dirs.has(rejected.allocation.path), true);
      f.filesystem.rmdirSync = rmdir;
      f.manager.dispose(rejected.allocation);
      assert.equal(f.dirs.has(rejected.allocation.path), false);
    } else {
      assert.equal(rejected.allocation, undefined);
      assert.deepEqual(f.mutations.map(([operation]) => operation), ['mkdir', 'rmdir']);
    }
  });
}

test('exclusive mkdir collision does not roll back somebody else\'s directory', (t) => {
  const f = fixture();
  t.mock.method(f.filesystem, 'mkdirSync', () => { throw f.fail('EEXIST'); });
  assert.throws(() => prepare(f.manager), { code: 'EEXIST' });
  assert.deepEqual(f.mutations, []);
});

test('cancelled preparation does not create a group; cancellation after mkdir rolls it back', (t) => {
  const f = fixture();
  const cancelled = new AbortController();
  cancelled.abort();
  assert.throws(() => f.manager.prepare('cancelled', { mode: 'enforce' }, { signal: cancelled.signal }), { name: 'AbortError' });
  assert.deepEqual(f.mutations, []);
  const cancellation = new AbortController();
  const mkdir = f.filesystem.mkdirSync;
  t.mock.method(f.filesystem, 'mkdirSync', (...args) => { mkdir(...args); cancellation.abort(); });
  assert.throws(() => f.manager.prepare('late-cancel', { mode: 'enforce' }, { signal: cancellation.signal }), ResourceSetupError);
  assert.deepEqual(f.mutations.map(([operation]) => operation), ['mkdir', 'rmdir']);
});

test('PID placement checks identity, writes only cgroup.procs, and verifies membership', () => {
  const f = fixture();
  const allocation = prepare(f.manager);
  f.manager.attach(allocation, 4242);
  assert.equal(f.files.get('/proc/4242/cgroup'), `0::${allocation.cgroupPath}`);
  assert.equal(f.fds.size, 0);
  assert.deepEqual(f.mutations[1], ['write', `${allocation.path}/cgroup.procs`, '4242\n']);
  assert.throws(() => f.manager.dispose(allocation), { code: 'CGROUP_POPULATED' });
  f.exit(allocation);
  f.manager.dispose(allocation);
});

test('invalid PIDs, nonchildren, zombies, and outside processes cannot be placed', () => {
  const f = fixture();
  const allocation = prepare(f.manager);
  for (const pid of [0, -1, 1.5, '4242', null, 2147483648]) assert.throws(() => f.manager.attach(allocation, pid), { code: 'CGROUP_PID_INVALID' });
  f.processFiles(4242, { ppid: 1 });
  assert.throws(() => f.manager.attach(allocation, 4242), { code: 'CGROUP_PROCESS_IDENTITY' });
  f.processFiles(4242, { state: 'Z' });
  assert.throws(() => f.manager.attach(allocation, 4242), { code: 'CGROUP_PROCESS_IDENTITY' });
  f.processFiles(4242, { membership: '/other' });
  assert.throws(() => f.manager.attach(allocation, 4242), { code: 'CGROUP_SOURCE_OUTSIDE_DELEGATION' });
  assert.equal(f.mutations.length, 1);
  f.manager.dispose(allocation);
});

for (const phase of ['before', 'during-open']) {
  test(`placement cancellation ${phase} performs no write`, (t) => {
    const f = fixture();
    const allocation = prepare(f.manager);
    const cancellation = new AbortController();
    if (phase === 'before') cancellation.abort();
    else {
      const open = f.filesystem.openSync;
      t.mock.method(f.filesystem, 'openSync', (...args) => { const fd = open(...args); cancellation.abort(); return fd; });
    }
    assert.throws(() => f.manager.attach(allocation, 4242, { signal: cancellation.signal }), { name: 'AbortError' });
    assert.equal(f.mutations.length, 1);
    assert.equal(f.fds.size, 0);
    f.manager.dispose(allocation);
  });
}

test('changed start identity before placement is rejected with no write', (t) => {
  const f = fixture();
  const allocation = prepare(f.manager);
  const open = f.filesystem.openSync;
  t.mock.method(f.filesystem, 'openSync', (...args) => { const fd = open(...args); f.processFiles(4242, { start: '101' }); return fd; });
  assert.throws(() => f.manager.attach(allocation, 4242), { code: 'CGROUP_PROCESS_IDENTITY' });
  assert.equal(f.mutations.length, 1);
  assert.equal(f.fds.size, 0);
  f.manager.dispose(allocation);
});

test('placement write errors close descriptors and leave cleanup authoritative', (t) => {
  const f = fixture();
  const allocation = prepare(f.manager);
  t.mock.method(f.filesystem, 'writeSync', () => { throw f.fail('EACCES'); });
  assert.throws(() => f.manager.attach(allocation, 4242), { code: 'EACCES' });
  assert.equal(f.fds.size, 0);
  f.manager.dispose(allocation);
  assert.equal(f.dirs.has(allocation.path), false);
});

test('changed base identity and symlinked leaves cannot be mutated', () => {
  const f = fixture();
  const allocation = prepare(f.manager);
  const savedBase = f.dirs.get(f.base);
  f.dirs.set(f.base, { ...savedBase, ino: savedBase.ino + 1 });
  assert.throws(() => f.manager.attach(allocation, 4242), { code: 'CGROUP_PATH_UNSAFE' });
  assert.throws(() => f.manager.dispose(allocation), { code: 'CGROUP_PATH_UNSAFE' });
  f.dirs.set(f.base, savedBase);
  const savedLeaf = f.dirs.get(allocation.path);
  f.dirs.set(allocation.path, { ...savedLeaf, isSymbolicLink: () => true });
  assert.throws(() => f.manager.dispose(allocation), { code: 'CGROUP_PATH_UNSAFE' });
  assert.equal(f.mutations.length, 1);
  f.dirs.set(allocation.path, savedLeaf);
  f.manager.dispose(allocation);
});

test('failed membership verification rejects attachment', (t) => {
  const f = fixture();
  const allocation = prepare(f.manager);
  t.mock.method(f.filesystem, 'writeSync', (fd, value) => Buffer.byteLength(value));
  assert.throws(() => f.manager.attach(allocation, 4242), { code: 'CGROUP_PLACEMENT_FAILED' });
  f.manager.dispose(allocation);
});

test('snapshots parse controller counters, preserve large integers, and tolerate absent counters', () => {
  const f = fixture();
  const allocation = prepare(f.manager);
  const result = f.manager.snapshot(allocation);
  assert.equal(result.enforcing, false);
  assert.equal(result.memory.currentBytes, 12345);
  assert.equal(result.memory.events.high, 1);
  assert.equal(result.cpu.stat.usage_usec, 345);
  assert.deepEqual(result.pids, { current: 0, events: { max: 0 } });
  f.files.set(`${allocation.path}/memory.current`, '9007199254740993');
  f.files.delete(`${allocation.path}/pids.events`);
  assert.equal(f.manager.snapshot(allocation).memory.currentBytes, '9007199254740993');
  assert.equal(f.manager.snapshot(allocation).pids.events, null);
  f.files.set(`${allocation.path}/cpu.stat`, 'usage_usec not-a-number');
  assert.throws(() => f.manager.snapshot(allocation), { code: 'CGROUP_COUNTER_INVALID' });
  f.manager.dispose(allocation); // Bad observation data cannot prevent safe cleanup.
});

test('safe disposal rejects populated groups, unknown handles, identity changes, and children', () => {
  const f = fixture();
  const allocation = prepare(f.manager);
  assert.throws(() => f.manager.dispose({ kind: 'cgroup-v2', path: '/outside' }), { code: 'CGROUP_ALLOCATION_NOT_OWNED' });
  assert.throws(() => f.manager.attach({ kind: 'cgroup-v2', path: '/outside' }, 4242), { code: 'CGROUP_ALLOCATION_NOT_OWNED' });
  const saved = f.dirs.get(allocation.path);
  f.dirs.set(allocation.path, { ...saved, ino: saved.ino + 1 });
  assert.throws(() => f.manager.dispose(allocation), { code: 'CGROUP_PATH_UNSAFE' });
  f.dirs.set(allocation.path, saved);
  f.files.set(`${allocation.path}/cgroup.events`, 'populated 1\nfrozen 0');
  assert.throws(() => f.manager.dispose(allocation), { code: 'CGROUP_POPULATED' });
  f.files.set(`${allocation.path}/cgroup.events`, 'populated 0\nfrozen 0');
  f.group(`${allocation.path}/unexpected-child`);
  assert.throws(() => f.manager.dispose(allocation), { code: 'ENOTEMPTY' });
  assert.equal(f.mutations.length, 1); // No recursive deletion or process killing.
});

test('allocation-only backend status is retained by the runtime rather than claiming limits', async (t) => {
  const f = fixture();
  // Real child lifetime with a fake kernel placement; only backend filesystem writes are virtual.
  const attach = f.manager.attach;
  f.manager.attach = (allocation, pid, context) => { f.processFiles(pid); return attach(allocation, pid, context); };
  const dispose = f.manager.dispose;
  f.manager.dispose = (allocation) => { f.exit(allocation); return dispose(allocation); };
  const runtime = createOrchestrator({ resourceManager: f.manager, resourcePolicy: { mode: 'enforce' } });
  t.after(() => runtime.close());
  assert.equal((await runtime.request('get_system_info')).status, 'success');
  assert.equal(runtime.getAgentMetadata().resources.enforcementStatus, 'allocated');
  assert.ok(runtime.getAgentMetadata().resources.cgroupPath.startsWith('/runtime/agent-'));
  await runtime.close();
  assert.equal(runtime.getAgentMetadata().resources.latestSnapshot.kind, 'cgroup-v2');
  assert.equal(runtime.getAgentMetadata().resources.latestSnapshot.enforcing, false);
});

test('real delegated cgroup integration', {
  skip: !process.env.AI_NATIVE_OS_CGROUP_BASE && 'Set AI_NATIVE_OS_CGROUP_BASE from a writable delegated supervisor leaf to opt in',
}, async (t) => {
  const delegatedBasePath = process.env.AI_NATIVE_OS_CGROUP_BASE;
  const manager = createResourceManager({ delegatedBasePath });
  const facts = manager.inspect();
  assert.equal(facts.allocationAvailable, true, JSON.stringify(facts.delegated.blockers));
  const runtime = createOrchestrator({ delegatedBasePath, resourcePolicy: { mode: 'enforce' } });
  t.after(() => runtime.close());
  await runtime.start();
  const metadata = runtime.getAgentMetadata();
  assert.equal(metadata.resources.enforcementStatus, 'allocated');
  assert.equal(fs.readFileSync(`/proc/${metadata.pid}/cgroup`, 'utf8').trim(), `0::${metadata.resources.cgroupPath}`);
  const leaf = path.join(delegatedBasePath, path.posix.basename(metadata.resources.cgroupPath));
  assert.equal(fs.existsSync(leaf), true);
  assert.equal((await runtime.request('get_system_info')).status, 'success');
  await runtime.close();
  assert.equal(runtime.getAgentMetadata().resources.cleanupStatus, 'complete');
  assert.equal(runtime.getAgentMetadata().resources.latestSnapshot.pids.current, 0);
  assert.equal(fs.existsSync(leaf), false);
});
