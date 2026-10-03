const mode = process.env.AGENT_TEST_MODE;
let instanceId;
let count = 0;
if (mode === 'ignore-term' || mode === 'uncooperative') process.on('SIGTERM', () => {});
process.on('disconnect', () => {
  if (mode !== 'disconnect') process.exit(0);
});
process.on('message', (message) => {
  if (message.type === 'initialize') {
    instanceId = message.instanceId;
    const ready = () => process.send({ version: 1, type: 'ready', instanceId });
    if (mode === 'slow-ready') setTimeout(ready, 100);
    else ready();
    return;
  }
  if (message.type === 'shutdown') {
    if (mode !== 'uncooperative') process.exit(0);
    return;
  }
  if (mode === 'hang' || mode === 'ignore-term' || mode === 'uncooperative') return;
  if (mode === 'crash') return process.exit(7);
  if (mode === 'disconnect') {
    if (process.connected) {
      setInterval(() => {}, 1000);
      process.disconnect();
    }
    return;
  }
  if (mode === 'malformed') return process.send({ version: 1, instanceId, type: 'response', requestId: message.requestId, status: 'success', data: {} });
  if (mode === 'collection-error') return process.send({ version: 1, type: 'response', instanceId, requestId: message.requestId, status: 'error', error: { code: 'COLLECTION_FAILED', message: 'Fixture failure' } });
  if (mode === 'wrong-instance') return process.send({ version: 1, type: 'response', instanceId: 'wrong', requestId: message.requestId, status: 'success', data: {} });
  const sequence = ++count;
  setTimeout(() => {
    const response = {
      version: 1, type: 'response', instanceId, requestId: message.requestId,
      status: 'success', data: {
        hostname: `request-${sequence}`, kernelRelease: 'fixture', cpuCount: 1,
        totalMemoryBytes: 100, uptimeSeconds: 1,
      },
    };
    process.send(response);
    if (mode === 'duplicates') {
      process.send(response);
      process.send({ ...response, requestId: 'unknown-id' });
    }
  }, sequence === 1 ? 80 : 5);
});
