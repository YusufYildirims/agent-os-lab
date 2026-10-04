const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createResourceManager, validateResourcePolicy } = require('../src/core/resource-manager');

function discoveryFilesystem({ root = '/', mount = '/sys/fs/cgroup', membership = '/non-systemd',
  readOnly = true, controllers = 'cpu memory pids', denied = false, missing = false } = {}) {
  const location = `${mount}${membership.slice(root === '/' ? 0 : root.length)}`;
  const files = {
    '/proc/self/cgroup': `0::${membership}\n`,
    '/proc/self/mountinfo': `10 1 0:24 ${root} ${mount} ${readOnly ? 'ro' : 'rw'},nosuid - cgroup2 cgroup2 rw,nsdelegate\n`,
    [`${location}/cgroup.controllers`]: controllers,
    [`${location}/cgroup.subtree_control`]: '',
  };
  return {
    readFileSync(file) {
      if (missing || !(file in files)) throw Object.assign(new Error('Missing fixture'), { code: 'ENOENT' });
      return files[file];
    },
    accessSync() { if (denied) throw Object.assign(new Error('Denied'), { code: 'EACCES' }); },
  };
}

test('discovery reports v2, membership, controllers and a read-only mount without writes', () => {
  const manager = createResourceManager({ filesystem: discoveryFilesystem() });
  const facts = manager.inspect();
  assert.equal(facts.cgroupV2, true);
  assert.equal(facts.currentCgroup, '/non-systemd');
  assert.equal(facts.mountPath, '/sys/fs/cgroup');
  assert.equal(facts.cgroupPath, '/sys/fs/cgroup/non-systemd');
  assert.equal(facts.readOnly, true);
  assert.equal(facts.writable, false);
  assert.deepEqual(facts.controllers, { cpu: true, memory: true, pids: true });
  assert.equal(facts.enforcementAvailable, false);
  assert.ok(facts.blockers.some(({ code }) => code === 'CGROUP_READ_ONLY'));
});

test('discovery maps a subtree mount root to the current cgroup', () => {
  const facts = createResourceManager({ filesystem: discoveryFilesystem({ root: '/user.slice',
    mount: '/delegated', membership: '/user.slice/runtime', readOnly: false }) }).inspect();
  assert.equal(facts.cgroupPath, '/delegated/runtime');
  assert.equal(facts.writable, true);
  assert.equal(facts.enforcementAvailable, false);
});

test('discovery decodes escaped mount paths', () => {
  const filesystem = discoveryFilesystem({ mount: '/sys/fs/cgroup test' });
  const read = filesystem.readFileSync;
  filesystem.readFileSync = (file) => {
    const value = read(file);
    return file === '/proc/self/mountinfo' ? value.replace('/sys/fs/cgroup test', '/sys/fs/cgroup\\040test') : value;
  };
  const facts = createResourceManager({ filesystem }).inspect();
  assert.equal(facts.cgroupPath, '/sys/fs/cgroup test/non-systemd');
  assert.equal(facts.cgroupV2, true);
});

test('discovery reports permission and missing-controller blockers', () => {
  const facts = createResourceManager({ filesystem: discoveryFilesystem({ readOnly: false, denied: true, controllers: 'cpu' }) }).inspect();
  assert.equal(facts.writable, false);
  assert.deepEqual(facts.controllers, { cpu: true, memory: false, pids: false });
  assert.ok(facts.blockers.some(({ code }) => code === 'CGROUP_NOT_WRITABLE'));
  assert.ok(facts.blockers.some(({ code }) => code === 'CGROUP_CONTROLLERS_MISSING'));
});

test('discovery handles unavailable proc files and absent v2', () => {
  const facts = createResourceManager({ filesystem: discoveryFilesystem({ missing: true }) }).inspect();
  assert.equal(facts.cgroupV2, false);
  assert.equal(facts.blockers[0].code, 'CGROUP_DISCOVERY_FAILED');
  const filesystem = discoveryFilesystem();
  const read = filesystem.readFileSync;
  filesystem.readFileSync = (file) => file === '/proc/self/cgroup' ? '2:memory:/legacy' : read(file);
  assert.equal(createResourceManager({ filesystem }).inspect().blockers[0].code, 'CGROUP_V2_UNAVAILABLE');
});

test('disabled mode performs no discovery and observation is explicitly non-enforcing', () => {
  const manager = createResourceManager({ filesystem: discoveryFilesystem({ missing: true }) });
  const disabled = manager.prepare('instance', { mode: 'disabled' });
  assert.equal(disabled.capabilities, null);
  assert.equal(manager.snapshot(disabled), null);
  const observed = manager.prepare('instance', { mode: 'observe' });
  assert.equal(observed.enforcementStatus, 'observe');
  assert.equal(manager.snapshot(observed).enforcing, false);
  manager.attach(observed, 123);
  manager.dispose(observed);
});

test('enforcement is rejected even when the current location appears writable', () => {
  const manager = createResourceManager({ filesystem: discoveryFilesystem({ readOnly: false }) });
  assert.throws(() => manager.prepare('instance', { mode: 'enforce', memoryMaxBytes: 1024 }), {
    code: 'RESOURCE_ENFORCEMENT_UNAVAILABLE',
  });
});

test('policy validates future limits and rejects contradictory or invalid configuration', () => {
  assert.deepEqual(validateResourcePolicy(), { mode: 'disabled' });
  assert.deepEqual(validateResourcePolicy({ mode: 'enforce', cpuQuotaMicros: 50000, pidsMax: 16, memoryMaxBytes: 1024 }), {
    mode: 'enforce', cpuQuotaMicros: 50000, cpuPeriodMicros: 100000, pidsMax: 16, memoryMaxBytes: 1024,
  });
  for (const policy of [null, [], 1, { mode: 'invalid' }, { extra: true }, { pidsMax: 1 },
    { mode: 'observe', memoryMaxBytes: 1 }, { mode: 'enforce', cpuPeriodMicros: 1000 },
    ...[0, -1, 0.5, NaN, Infinity, '1', Number.MAX_SAFE_INTEGER + 1].map((pidsMax) => ({ mode: 'enforce', pidsMax }))]) {
    assert.throws(() => validateResourcePolicy(policy), TypeError);
  }
});
