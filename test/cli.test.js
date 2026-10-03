const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, fork } = require('node:child_process');
const { once } = require('node:events');
const { readFile } = require('node:fs/promises');
const { setTimeout: delay } = require('node:timers/promises');

async function waitGone(pid) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      // A reparented zombie has exited; only its new parent can reap it.
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) return;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') return;
      throw error;
    }
    await delay(20);
  }
  assert.fail(`Process ${pid} did not exit`);
}

test('CLI preserves system-info output and exits cleanly', { timeout: 5000 }, async (t) => {
  const cli = spawn(process.execPath, [require.resolve('../src/cli'), 'system-info'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (cli.exitCode === null && cli.signalCode === null) cli.kill('SIGKILL'); });
  const closed = once(cli, 'close');
  let stdout = '';
  let stderr = '';
  cli.stdout.on('data', (chunk) => { stdout += chunk; });
  cli.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await closed;
  assert.equal(code, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /^System information\nHostname: .+\nKernel release: .+\nCPU count: \d+\nTotal memory: .+\nUptime: \d+ seconds\n$/);
});

test('responsive agent exits when its parent is killed', { timeout: 5000 }, async (t) => {
  const parent = fork(require.resolve('./fixtures/parent.cjs'), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], execArgv: [] });
  let agentPid;
  t.after(() => {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
    if (agentPid) {
      try { process.kill(agentPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  });
  const exit = once(parent, 'exit');
  const [metadata] = await once(parent, 'message');
  agentPid = metadata.pid;
  parent.kill('SIGKILL');
  await exit;
  await waitGone(agentPid);
  agentPid = null;
});

for (const args of [[], ['unknown'], ['system-info', 'extra']]) {
  test(`CLI rejects arguments ${JSON.stringify(args)}`, { timeout: 5000 }, async () => {
    const cli = spawn(process.execPath, [require.resolve('../src/cli'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(cli, 'close');
    let stdout = '';
    let stderr = '';
    cli.stdout.on('data', (chunk) => { stdout += chunk; });
    cli.stderr.on('data', (chunk) => { stderr += chunk; });
    assert.equal((await closed)[0], 1);
    assert.equal(stdout, '');
    assert.equal(JSON.parse(stderr).error.code, 'INVALID_REQUEST');
  });
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`CLI ${signal} preserves exit code while a request is pending`, { timeout: 5000 }, async (t) => {
    const cli = fork(require.resolve('./fixtures/cli.cjs'), [], {
      env: { ...process.env, AGENT_TEST_MODE: 'hang' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [],
    });
    const closed = once(cli, 'close');
    t.after(() => { if (cli.exitCode === null && cli.signalCode === null) cli.kill('SIGKILL'); });
    let stderr = '';
    cli.stderr.on('data', (chunk) => { stderr += chunk; });
    const [metadata] = await once(cli, 'message');
    cli.kill(signal);
    assert.equal((await closed)[0], code);
    assert.equal(JSON.parse(stderr).error.code, 'RUNTIME_CLOSED');
    await waitGone(metadata.pid);
  });
}

test('CLI reports agent operation failure', { timeout: 5000 }, async () => {
  const cli = fork(require.resolve('./fixtures/cli.cjs'), [], {
    env: { ...process.env, AGENT_TEST_MODE: 'collection-error' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [],
  });
  const closed = once(cli, 'close');
  let stderr = '';
  cli.stderr.on('data', (chunk) => { stderr += chunk; });
  assert.equal((await closed)[0], 1);
  assert.equal(JSON.parse(stderr).error.code, 'COLLECTION_FAILED');
});
