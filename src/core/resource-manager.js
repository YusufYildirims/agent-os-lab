const fs = require('node:fs');
const path = require('node:path');
const { createCgroupV2Backend } = require('./cgroup-v2');

// Ownership of a surviving allocation transfers to the caller on rejection.
class ResourceSetupError extends Error {
  constructor(setupError, { allocation, rollbackError } = {}) {
    super(setupError?.message || String(setupError), { cause: setupError });
    if (allocation !== undefined && (!allocation || typeof allocation !== 'object')) {
      throw new TypeError('Surviving allocation must be an object');
    }
    if (rollbackError !== undefined && allocation === undefined) {
      throw new TypeError('Rollback failure requires the surviving allocation');
    }
    this.name = 'ResourceSetupError';
    this.code = 'RESOURCE_SETUP_FAILED';
    this.allocation = allocation;
    this.rollbackError = rollbackError;
  }
}

function validateResourcePolicy(policy = {}) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new TypeError('resourcePolicy must be an object');
  }
  const keys = ['mode', 'memoryMaxBytes', 'cpuQuotaMicros', 'cpuPeriodMicros', 'pidsMax'];
  if (Object.keys(policy).some((key) => !keys.includes(key))) throw new TypeError('Unknown resource policy field');
  const mode = policy.mode ?? 'disabled';
  if (!['disabled', 'observe', 'enforce'].includes(mode)) throw new TypeError('Invalid resource policy mode');
  const result = { mode };
  for (const key of keys.slice(1)) {
    if (policy[key] === undefined) continue;
    if (!Number.isSafeInteger(policy[key]) || policy[key] <= 0) throw new TypeError(`${key} must be a positive safe integer`);
    result[key] = policy[key];
  }
  if (mode !== 'enforce' && Object.keys(result).length > 1) throw new TypeError('Resource limits require enforce mode');
  if (result.cpuPeriodMicros !== undefined && result.cpuQuotaMicros === undefined) throw new TypeError('cpuPeriodMicros requires cpuQuotaMicros');
  if (result.cpuQuotaMicros !== undefined) result.cpuPeriodMicros ??= 100000;
  return Object.freeze(result);
}

// Discovery never mutates cgroups. The backend requires explicit delegation.
function createResourceManager({ filesystem = fs, delegatedBasePath } = {}) {
  const backend = createCgroupV2Backend({ filesystem, delegatedBasePath, setupError: ResourceSetupError });
  function inspect() {
    const facts = {
      cgroupV2: false, currentCgroup: null, mountPath: null, mountRoot: null,
      cgroupPath: null, readOnly: null, writable: false, availableControllers: [],
      enabledChildControllers: [], controllers: { cpu: false, memory: false, pids: false },
      enforcing: false, enforcementAvailable: false, blockers: [],
    };
    const read = (file) => filesystem.readFileSync(file, 'utf8').trim();
    const decode = (value) => value.replace(/\\([0-7]{3})/g, (_, digits) => String.fromCharCode(parseInt(digits, 8)));
    try {
      const membership = read('/proc/self/cgroup').split('\n').find((line) => line.startsWith('0::'));
      facts.currentCgroup = membership?.slice(3) ?? null;
      const mounts = read('/proc/self/mountinfo').split('\n').map((line) => {
        const [left, right] = line.split(' - ');
        return { fields: left.split(' '), type: right?.split(' ')[0] };
      });
      const candidates = mounts.filter(({ fields, type }) => {
        const root = decode(fields[3]);
        return type === 'cgroup2' && facts.currentCgroup !== null &&
          (root === '/' || facts.currentCgroup === root || facts.currentCgroup.startsWith(`${root}/`));
      });
      const mount = candidates.sort((a, b) => Number(a.fields[5].split(',').includes('ro')) - Number(b.fields[5].split(',').includes('ro')))[0];
      if (!mount) {
        facts.blockers.push({ code: 'CGROUP_V2_UNAVAILABLE', message: 'No accessible cgroup v2 mount for the current membership' });
      } else {
        facts.cgroupV2 = true;
        facts.mountRoot = decode(mount.fields[3]);
        facts.mountPath = decode(mount.fields[4]);
        facts.readOnly = mount.fields[5].split(',').includes('ro');
        const relative = path.posix.relative(facts.mountRoot, facts.currentCgroup);
        if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) throw new Error('Invalid cgroup membership path');
        facts.cgroupPath = path.join(facts.mountPath, relative);
        facts.availableControllers = read(path.join(facts.cgroupPath, 'cgroup.controllers')).split(/\s+/).filter(Boolean);
        facts.enabledChildControllers = read(path.join(facts.cgroupPath, 'cgroup.subtree_control')).split(/\s+/).filter(Boolean);
        for (const name of Object.keys(facts.controllers)) facts.controllers[name] = facts.availableControllers.includes(name);
        if (facts.readOnly) facts.blockers.push({ code: 'CGROUP_READ_ONLY', message: 'The cgroup mount is read-only in this mount namespace' });
        else {
          try {
            for (const file of ['', 'cgroup.procs', 'cgroup.subtree_control']) filesystem.accessSync(path.join(facts.cgroupPath, file), fs.constants.W_OK);
            facts.writable = true;
          } catch {
            facts.blockers.push({ code: 'CGROUP_NOT_WRITABLE', message: 'Current cgroup directory or delegation files are not writable' });
          }
        }
        const missing = Object.keys(facts.controllers).filter((name) => !facts.controllers[name]);
        if (missing.length) facts.blockers.push({ code: 'CGROUP_CONTROLLERS_MISSING', message: `Unavailable controllers: ${missing.join(', ')}` });
      }
    } catch (error) {
      facts.blockers.push({ code: 'CGROUP_DISCOVERY_FAILED', message: error.message });
    }
    facts.delegated = backend.inspect();
    facts.allocationAvailable = facts.delegated.allocationAvailable;
    facts.blockers.push(...facts.delegated.blockers);
    facts.blockers.push({ code: 'RESOURCE_LIMITS_NOT_IMPLEMENTED', message: 'Memory, CPU and task limits are not implemented; delegated allocation is non-limiting' });
    return facts;
  }

  function prepare(instanceId, policy, context) {
    const requested = validateResourcePolicy(policy);
    const capabilities = requested.mode === 'disabled' ? null : inspect();
    if (requested.mode === 'enforce') {
      if (!capabilities.allocationAvailable) {
        throw Object.assign(new Error(capabilities.delegated.blockers.map(({ message }) => message).join('; ')), {
          code: 'RESOURCE_ENFORCEMENT_UNAVAILABLE', capabilities,
        });
      }
      return backend.prepare(instanceId, requested, context);
    }
    return { instanceId, enforcementStatus: requested.mode, capabilities };
  }

  return {
    inspect, prepare,
    attach(allocation, pid, context) {
      if (allocation.kind === 'cgroup-v2') return backend.attach(allocation, pid, context);
    },
    snapshot(allocation) {
      if (allocation.kind === 'cgroup-v2') return backend.snapshot(allocation);
      return allocation.capabilities ? { kind: 'discovery', enforcing: false, sampledAt: new Date().toISOString(), capabilities: inspect() } : null;
    },
    dispose(allocation) {
      if (allocation.kind === 'cgroup-v2') return backend.dispose(allocation);
    },
  };
}

module.exports = { createResourceManager, validateResourcePolicy, ResourceSetupError };
