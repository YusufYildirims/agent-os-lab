const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const REQUIRED_CONTROLLERS = ['cpu', 'memory', 'pids'];
const error = (code, message, cause) => Object.assign(new Error(message, { cause }), { code });
const inside = (base, target) => target === base || target.startsWith(base === '/' ? '/' : `${base}/`);
const decode = (value) => value.replace(/\\([0-7]{3})/g, (_, digits) => String.fromCharCode(parseInt(digits, 8)));

function integer(value) {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw error('CGROUP_COUNTER_INVALID', `Invalid cgroup counter: ${value}`);
  const number = BigInt(value);
  return number <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(number) : value;
}

function counters(text) {
  const result = {};
  for (const line of text.trim().split('\n').filter(Boolean)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 2 || !/^[a-z][a-z0-9_]*$/.test(parts[0]) || Object.hasOwn(result, parts[0])) {
      throw error('CGROUP_COUNTER_INVALID', 'Malformed cgroup counter table');
    }
    result[parts[0]] = integer(parts[1]);
  }
  return result;
}

// Only mkdir, cgroup.procs writes, and non-recursive rmdir mutate this backend.
// Operations are synchronous over small kernel files to avoid async PID-placement gaps.
function createCgroupV2Backend({ filesystem = fs, delegatedBasePath, setupError }) {
  const allocations = new WeakMap();
  const read = (file) => filesystem.readFileSync(file, 'utf8').trim();
  const abort = (signal) => { signal?.throwIfAborted(); };
  const identity = (directory) => {
    const stat = filesystem.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('CGROUP_PATH_UNSAFE', 'Cgroup path must be a real directory');
    if (filesystem.realpathSync(directory) !== directory) throw error('CGROUP_PATH_UNSAFE', 'Symlinked cgroup paths are not supported');
    return { dev: stat.dev, ino: stat.ino };
  };
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
  const membership = (pid = 'self') => {
    const line = read(`/proc/${pid}/cgroup`).split('\n').find((entry) => entry.startsWith('0::'));
    if (!line) throw error('CGROUP_V2_UNAVAILABLE', 'Process has no cgroup v2 membership');
    return line.slice(3);
  };

  function base() {
    if (delegatedBasePath === undefined) throw error('CGROUP_DELEGATION_REQUIRED', 'An explicit writable delegatedBasePath is required');
    if (typeof delegatedBasePath !== 'string' || !path.isAbsolute(delegatedBasePath) ||
        delegatedBasePath.includes('\0') || delegatedBasePath.split('/').some((part) => part === '.' || part === '..')) {
      throw error('CGROUP_BASE_PATH_INVALID', 'delegatedBasePath must be an absolute path without traversal');
    }
    const basePath = path.resolve(delegatedBasePath);
    let baseIdentity;
    try { baseIdentity = identity(basePath); }
    catch (cause) { throw error(cause.code === 'ENOENT' ? 'CGROUP_BASE_MISSING' : cause.code, `Cannot use delegated base: ${cause.message}`, cause); }
    const mounts = read('/proc/self/mountinfo').split('\n').map((line) => {
      const [left, right] = line.split(' - ');
      const fields = left.split(' ');
      return { path: decode(fields[4]), root: decode(fields[3]), readOnly: fields[5].split(',').includes('ro'), type: right.split(' ')[0] };
    });
    const mount = mounts.filter((item) => inside(item.path, basePath)).sort((a, b) => b.path.length - a.path.length)[0];
    if (mount?.type !== 'cgroup2' || Number(filesystem.statfsSync(basePath).type) !== 0x63677270) {
      throw error('CGROUP_BASE_NOT_V2', 'Delegated base is not on a cgroup v2 filesystem');
    }
    if (basePath === mount.path && mount.root === '/') throw error('CGROUP_BASE_NOT_DELEGATED', 'The global cgroup root is not a delegated runtime subtree');
    if (mount.readOnly) throw error('CGROUP_READ_ONLY', 'Delegated base mount is read-only in this mount namespace');
    try {
      filesystem.accessSync(basePath, fs.constants.W_OK | fs.constants.X_OK);
      filesystem.accessSync(path.join(basePath, 'cgroup.procs'), fs.constants.W_OK);
      for (const file of ['cgroup.controllers', 'cgroup.subtree_control', 'cgroup.type', 'cgroup.events', 'cgroup.procs']) read(path.join(basePath, file));
    } catch (cause) {
      throw error(cause.code === 'ENOENT' ? 'CGROUP_CONTROL_FILE_MISSING' : 'CGROUP_BASE_NOT_WRITABLE', `Delegated base control files are inaccessible: ${cause.message}`, cause);
    }
    if (read(path.join(basePath, 'cgroup.type')) !== 'domain' || read(path.join(basePath, 'cgroup.procs')) !== '') {
      throw error('CGROUP_BASE_TOPOLOGY', 'Delegated base must be an empty domain cgroup; run the supervisor in a child/sibling leaf');
    }
    const available = read(path.join(basePath, 'cgroup.controllers')).split(/\s+/);
    const enabled = read(path.join(basePath, 'cgroup.subtree_control')).split(/\s+/);
    for (const controller of REQUIRED_CONTROLLERS) {
      if (!available.includes(controller)) throw error('CGROUP_CONTROLLER_UNAVAILABLE', `Controller ${controller} is unavailable at delegated base`);
      if (!enabled.includes(controller)) throw error('CGROUP_CONTROLLER_NOT_ENABLED', `Controller ${controller} is not enabled for delegated children; backend never changes subtree_control`);
    }
    const cgroupPath = path.posix.join(mount.root, path.relative(mount.path, basePath));
    const currentCgroup = membership();
    if (currentCgroup === cgroupPath || !inside(cgroupPath, currentCgroup)) {
      throw error('CGROUP_SOURCE_OUTSIDE_DELEGATION', 'Supervisor must already run in a child of the assigned delegated base');
    }
    return { basePath, identity: baseIdentity, cgroupPath, mountPath: mount.path, currentCgroup,
      controllers: REQUIRED_CONTROLLERS.slice(), writable: true, allocationAvailable: true };
  }

  function inspect() {
    try { return { ...base(), blockers: [] }; }
    catch (cause) { return { basePath: delegatedBasePath ?? null, allocationAvailable: false, blockers: [{ code: cause.code || 'CGROUP_BASE_INVALID', message: cause.message }] }; }
  }

  function owned(allocation) {
    const record = allocations.get(allocation);
    if (!record) throw error('CGROUP_ALLOCATION_NOT_OWNED', 'Allocation was not created by this manager');
    if (record.disposed) throw error('CGROUP_ALLOCATION_DISPOSED', 'Allocation was already disposed');
    if (path.dirname(record.path) !== record.base.basePath || !same(identity(record.base.basePath), record.base.identity)) {
      throw error('CGROUP_PATH_UNSAFE', 'Delegated base identity changed');
    }
    if (!record.identity || !same(identity(record.path), record.identity)) throw error('CGROUP_PATH_UNSAFE', 'Allocation identity changed');
    return record;
  }

  function dispose(allocation) {
    const record = allocations.get(allocation);
    if (!record) throw error('CGROUP_ALLOCATION_NOT_OWNED', 'Allocation was not created by this manager');
    if (record.disposed) return;
    owned(allocation);
    const events = counters(read(path.join(record.path, 'cgroup.events')));
    if (events.populated !== 0 || read(path.join(record.path, 'cgroup.procs')) !== '') {
      throw error('CGROUP_POPULATED', 'Allocation is populated or its empty state cannot be verified; no processes will be killed');
    }
    // Kernel rmdir rejects populated groups and groups with children, including races.
    filesystem.rmdirSync(record.path);
    record.disposed = true;
  }

  function prepare(instanceId, policy, { signal } = {}) {
    abort(signal);
    if (typeof instanceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(instanceId)) {
      throw error('CGROUP_INSTANCE_INVALID', 'instanceId must be a safe single path component');
    }
    const info = base();
    if (Object.keys(policy).some((key) => key !== 'mode')) {
      throw error('RESOURCE_LIMITS_NOT_IMPLEMENTED', 'Stage 3 supports cgroup allocation/placement only; memory, CPU and task limits are deferred');
    }
    const name = `agent-${instanceId}-${randomUUID()}`;
    const location = path.join(info.basePath, name);
    const allocation = Object.freeze({ kind: 'cgroup-v2', instanceId, cgroupPath: path.posix.join(info.cgroupPath, name),
      path: location, enforcementStatus: 'allocated', capabilities: { delegated: inspect(), enforcing: false } });
    const record = { path: location, base: info, disposed: false, identity: null };
    abort(signal);
    if (!same(identity(info.basePath), info.identity)) throw error('CGROUP_PATH_UNSAFE', 'Delegated base identity changed before allocation');
    filesystem.mkdirSync(location, { mode: 0o700 }); // Exclusive creation, never recursive.
    allocations.set(allocation, record);
    try {
      record.identity = identity(location);
      abort(signal);
      if (read(path.join(location, 'cgroup.type')) !== 'domain') throw error('CGROUP_LEAF_TOPOLOGY', 'New allocation is not a domain cgroup');
      const controllers = read(path.join(location, 'cgroup.controllers')).split(/\s+/);
      for (const controller of REQUIRED_CONTROLLERS) {
        if (!controllers.includes(controller)) throw error('CGROUP_CONTROLLER_UNAVAILABLE', `New allocation lacks ${controller}`);
      }
      filesystem.accessSync(path.join(location, 'cgroup.procs'), fs.constants.W_OK);
      if (counters(read(path.join(location, 'cgroup.events'))).populated !== 0 || read(path.join(location, 'cgroup.procs')) !== '') {
        throw error('CGROUP_POPULATED', 'New allocation must be empty');
      }
      return allocation;
    } catch (cause) {
      try { dispose(allocation); }
      catch (rollbackError) { throw new setupError(cause, { allocation, rollbackError }); }
      throw new setupError(cause);
    }
  }

  function processIdentity(pid) {
    const stat = read(`/proc/${pid}/stat`);
    const end = stat.lastIndexOf(')');
    const fields = stat.slice(end + 2).split(/\s+/);
    if (end < 0 || !stat.startsWith(`${pid} (`) || fields.length < 20 || !/^\d+$/.test(fields[19])) {
      throw error('CGROUP_PROCESS_IDENTITY', 'Invalid process stat identity');
    }
    if (['Z', 'X', 'x'].includes(fields[0]) || Number(fields[1]) !== process.pid) {
      throw error('CGROUP_PROCESS_IDENTITY', 'Placement is restricted to live direct children of the supervisor');
    }
    return fields[19]; // /proc stat field 22: start time; comm may contain spaces/parentheses.
  }

  function attach(allocation, pid, { signal } = {}) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) throw error('CGROUP_PID_INVALID', 'PID must be a positive Linux PID');
    abort(signal);
    const record = owned(allocation);
    const startTime = processIdentity(pid);
    const source = membership(pid);
    if (!inside(record.base.cgroupPath, source)) throw error('CGROUP_SOURCE_OUTSIDE_DELEGATION', 'Child process is outside the delegated subtree');
    // Open without create/truncate/following links. Keep the final identity check and
    // placement synchronous; Node does not expose atomic pidfd-based cgroup placement.
    const fd = filesystem.openSync(path.join(record.path, 'cgroup.procs'), fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
    try {
      abort(signal);
      owned(allocation);
      if (processIdentity(pid) !== startTime) throw error('CGROUP_PROCESS_IDENTITY', 'PID identity changed before placement');
      const value = `${pid}\n`;
      if (filesystem.writeSync(fd, value) !== Buffer.byteLength(value)) throw error('CGROUP_PLACEMENT_FAILED', 'Incomplete PID placement write');
    } finally { filesystem.closeSync(fd); }
    if (processIdentity(pid) !== startTime || membership(pid) !== allocation.cgroupPath) {
      throw error('CGROUP_PLACEMENT_FAILED', 'Process identity or cgroup membership verification failed after placement');
    }
    abort(signal);
  }

  function snapshot(allocation) {
    const record = owned(allocation);
    const optional = (file, parse) => {
      try { return parse(read(path.join(record.path, file))); }
      catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
    };
    return { kind: 'cgroup-v2', cgroupPath: allocation.cgroupPath, enforcing: false, sampledAt: new Date().toISOString(),
      memory: { currentBytes: optional('memory.current', integer), events: optional('memory.events', counters) },
      cpu: { stat: optional('cpu.stat', counters) },
      pids: { current: optional('pids.current', integer), events: optional('pids.events', counters) } };
  }

  return { inspect, prepare, attach, snapshot, dispose };
}

module.exports = { createCgroupV2Backend };
