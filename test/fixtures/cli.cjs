const { runCli } = require('../../src/cli');
const { createOrchestrator } = require('../../src/core/orchestrator');
const runtime = createOrchestrator({ agentPath: require.resolve('./agent.cjs'), terminationGraceMs: 40 });
const originalRequest = runtime.request;
runtime.request = async (...args) => {
  await runtime.start();
  const result = originalRequest(...args);
  process.send(runtime.getAgentMetadata());
  return result;
};
void runCli(['system-info'], runtime).finally(() => process.disconnect());
