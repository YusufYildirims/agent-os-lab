const { test } = require('node:test');
const assert = require('node:assert/strict');

const agentPath = require.resolve('../src/agents/system-agent');
const orchestratorPath = require.resolve('../src/core/orchestrator');
require(agentPath);

// Load the orchestrator with a controlled worker to exercise delegation and deadlines.
function withAgent(t, agent) {
  const originalAgent = require.cache[agentPath].exports;
  const originalOrchestrator = require.cache[orchestratorPath];
  require.cache[agentPath].exports = agent;
  delete require.cache[orchestratorPath];
  const orchestrate = require(orchestratorPath);
  require.cache[agentPath].exports = originalAgent;
  t.after(() => {
    delete require.cache[orchestratorPath];
    if (originalOrchestrator) require.cache[orchestratorPath] = originalOrchestrator;
  });
  return orchestrate;
}

test('Orchestrator delegates the operation and preserves the worker response', async (t) => {
  const requests = [];
  const orchestrate = withAgent(t, async (request) => {
    requests.push(request);
    return { requestId: request.requestId, status: 'success', data: { hostname: 'test-host' } };
  });
  const first = await orchestrate('get_system_info');
  const second = await orchestrate('get_system_info');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], { requestId: first.requestId, operation: 'get_system_info' });
  assert.equal(typeof first.requestId, 'string');
  assert.ok(first.requestId.length > 0);
  assert.notEqual(first.requestId, second.requestId);
  assert.deepEqual(first, { requestId: first.requestId, status: 'success', data: { hostname: 'test-host' } });
});

test('Orchestrator rejects invalid operations and deadlines before delegation', async (t) => {
  let calls = 0;
  const orchestrate = withAgent(t, () => { calls += 1; });
  const responses = [await orchestrate('shell')];
  for (const timeout of [0, -1, 0.5, NaN, Infinity, '1000', null, 2147483648]) {
    responses.push(await orchestrate('get_system_info', timeout));
  }
  for (const response of responses) {
    assert.equal(response.status, 'error');
    assert.equal(response.error.code, 'INVALID_REQUEST');
    assert.equal('data' in response, false);
  }
  assert.equal(calls, 0);
});

test('Orchestrator preserves structured System Agent errors', async (t) => {
  const orchestrate = withAgent(t, async ({ requestId }) => ({
    requestId, status: 'error', error: { code: 'COLLECTION_FAILED', message: 'Collection unavailable' },
  }));
  const response = await orchestrate('get_system_info');
  assert.deepEqual(response.error, { code: 'COLLECTION_FAILED', message: 'Collection unavailable' });
  assert.equal(response.status, 'error');
});

test('Orchestrator handles synchronous exceptions and asynchronous rejections', async (t) => {
  for (const agent of [
    () => { throw new Error('private detail'); },
    async () => { throw new Error('private detail'); },
  ]) {
    const orchestrate = withAgent(t, agent);
    const response = await orchestrate('get_system_info');
    assert.equal(response.status, 'error');
    assert.deepEqual(response.error, { code: 'COLLECTION_FAILED', message: 'System Agent request failed' });
  }
});

test('Orchestrator times out when the worker does not respond', async (t) => {
  const orchestrate = withAgent(t, () => new Promise(() => {}));
  const response = await orchestrate('get_system_info', 10);
  assert.equal(response.status, 'error');
  assert.deepEqual(response.error, { code: 'TIMEOUT', message: 'System Agent request timed out' });
  assert.equal('data' in response, false);
});
