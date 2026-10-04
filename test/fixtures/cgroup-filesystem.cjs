const path = require('node:path');
const assert = require('node:assert/strict');

// A virtual cgroup filesystem. No real filesystem or host cgroup is mutated.
function cgroupFilesystem() {
  const base = '/cg/runtime';
  const files = new Map([
    ['/proc/self/mountinfo', '10 1 0:24 / /cg rw,nosuid - cgroup2 cgroup2 rw,nsdelegate\n'],
    ['/proc/self/cgroup', '0::/runtime/supervisor\n'],
  ]);
  const dirs = new Map();
  const fds = new Map();
  const mutations = [];
  let nextIno = 100;
  let nextFd = 10;
  const fail = (code) => Object.assign(new Error(code), { code });
  function group(location, { populated = 0, procs = '' } = {}) {
    dirs.set(location, { dev: 24, ino: nextIno++, isDirectory: () => true, isSymbolicLink: () => false });
    for (const [file, value] of Object.entries({
      'cgroup.controllers': 'cpu memory pids', 'cgroup.subtree_control': '',
      'cgroup.type': 'domain', 'cgroup.events': `populated ${populated}\nfrozen 0`, 'cgroup.procs': procs,
      'memory.current': '12345', 'memory.events': 'low 0\nhigh 1\nmax 0\noom 0\noom_kill 0',
      'cpu.stat': 'usage_usec 345\nuser_usec 200\nsystem_usec 145',
      'pids.current': '0', 'pids.events': 'max 0',
    })) files.set(`${location}/${file}`, value);
  }
  group('/cg');
  group(base, { populated: 1 });
  group(`${base}/supervisor`, { populated: 1, procs: `${process.pid}` });
  files.set(`${base}/cgroup.subtree_control`, 'cpu memory pids');
  function processFiles(pid = 4242, { ppid = process.pid, start = '100', state = 'S', membership = '/runtime/supervisor' } = {}) {
    const tail = Array.from({ length: 20 }, () => '0');
    tail[0] = state;
    tail[1] = String(ppid);
    tail[19] = start;
    files.set(`/proc/${pid}/stat`, `${pid} (a tricky ) name) ${tail.join(' ')}`);
    files.set(`/proc/${pid}/cgroup`, `0::${membership}`);
  }
  processFiles();
  const filesystem = {
    readFileSync(file) { if (!files.has(file)) throw fail('ENOENT'); return files.get(file); },
    lstatSync(file) { if (!dirs.has(file)) throw fail('ENOENT'); return dirs.get(file); },
    realpathSync(file) { if (!dirs.has(file)) throw fail('ENOENT'); return file; },
    statfsSync() { return { type: 0x63677270 }; },
    accessSync(file) { if (!dirs.has(file) && !files.has(file)) throw fail('ENOENT'); },
    mkdirSync(location, options) {
      assert.equal(path.dirname(location), base);
      assert.equal(options.recursive, undefined);
      if (dirs.has(location)) throw fail('EEXIST');
      mutations.push(['mkdir', location]);
      group(location);
    },
    openSync(file, flags) { if (!files.has(file)) throw fail('ENOENT'); const fd = nextFd++; fds.set(fd, { file, flags }); return fd; },
    writeSync(fd, value) {
      const { file } = fds.get(fd);
      assert.equal(path.dirname(path.dirname(file)), base);
      assert.equal(path.basename(file), 'cgroup.procs');
      mutations.push(['write', file, value]);
      files.set(file, value.trim());
      files.set(`${path.dirname(file)}/cgroup.events`, 'populated 1\nfrozen 0');
      files.set(`${path.dirname(file)}/pids.current`, '1');
      files.set(`/proc/${value.trim()}/cgroup`, `0::${path.dirname(file).slice('/cg'.length)}`);
      return Buffer.byteLength(value);
    },
    closeSync(fd) { fds.delete(fd); },
    rmdirSync(location) {
      assert.equal(path.dirname(location), base);
      if (!dirs.has(location)) throw fail('ENOENT');
      if (files.get(`${location}/cgroup.events`).startsWith('populated 1')) throw fail('EBUSY');
      if ([...dirs.keys()].some((entry) => path.dirname(entry) === location)) throw fail('ENOTEMPTY');
      mutations.push(['rmdir', location]);
      dirs.delete(location);
      for (const file of files.keys()) if (path.dirname(file) === location) files.delete(file);
    },
  };
  function exit(allocation) {
    files.set(`${allocation.path}/cgroup.procs`, '');
    files.set(`${allocation.path}/cgroup.events`, 'populated 0\nfrozen 0');
    files.set(`${allocation.path}/pids.current`, '0');
  }
  return { filesystem, files, dirs, fds, mutations, group, processFiles, exit, base, fail };
}

module.exports = { cgroupFilesystem };
