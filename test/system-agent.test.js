const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const systemAgent = require('../src/agents/system-agent');

const request = { requestId: 'req-test', operation: 'get_system_info' };

test('System Agent returns all system observations with the request ID', async (t) => {
  t.mock.method(os, 'hostname', () => 'test-host');
  t.mock.method(os, 'release', () => 'test-kernel');
  t.mock.method(os, 'cpus', () => [{}, {}]);
  t.mock.method(os, 'totalmem', () => 8589934592);
  t.mock.method(os, 'uptime', () => 1200.5);
  assert.deepEqual(await systemAgent(request), {
    requestId: 'req-test',
    status: 'success',
    data: {
      hostname: 'test-host', kernelRelease: 'test-kernel', cpuCount: 2,
      totalMemoryBytes: 8589934592, uptimeSeconds: 1200.5,
    },
  });
});

test('System Agent rejects malformed requests', async () => {
  for (const invalid of [undefined, null, [], 'request', {},
    { ...request, requestId: '' }, { ...request, requestId: '  ' },
    { ...request, requestId: 123 }, { ...request, operation: 'shell' },
    { ...request, parameters: {} }]) {
    const response = await systemAgent(invalid);
    assert.equal(response.status, 'error');
    assert.equal(response.error.code, 'INVALID_REQUEST');
    assert.equal('data' in response, false);
  }
});

test('System Agent converts collection exceptions into structured errors', async (t) => {
  t.mock.method(os, 'hostname', () => { throw new Error('private detail'); });
  assert.deepEqual(await systemAgent(request), {
    requestId: 'req-test', status: 'error',
    error: { code: 'COLLECTION_FAILED', message: 'Unable to read system information' },
  });
});

test('System Agent rejects invalid observations without partial data', async (t) => {
  for (const [method, value] of [
    ['hostname', null], ['release', null], ['cpus', []],
    ['totalmem', -1], ['totalmem', 0.5], ['uptime', NaN], ['uptime', -1],
  ]) {
    const mocked = t.mock.method(os, method, () => value);
    try {
      const response = await systemAgent(request);
      assert.equal(response.error.code, 'COLLECTION_FAILED');
      assert.equal('data' in response, false);
    } finally {
      mocked.mock.restore();
    }
  }
});
