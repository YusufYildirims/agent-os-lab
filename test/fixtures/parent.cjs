const { createOrchestrator } = require('../../src/core/orchestrator');
const runtime = createOrchestrator();
runtime.start().then(() => {
  process.send(runtime.getAgentMetadata());
}).catch(() => process.exit(1));
