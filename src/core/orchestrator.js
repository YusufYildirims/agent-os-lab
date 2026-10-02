const { randomUUID } = require('node:crypto');
const systemAgent = require('../agents/system-agent');

async function orchestrate(operation, timeoutMs = 1000) {
  const requestId = randomUUID();
  const error = (code, message) => ({
    requestId,
    status: 'error',
    error: { code, message },
  });

  if (operation !== 'get_system_info') {
    return error('INVALID_REQUEST', 'Only get_system_info is supported');
  }

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
    return error('INVALID_REQUEST', 'timeoutMs must be an integer from 1 to 2147483647');
  }

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve(error('TIMEOUT', 'System Agent request timed out'));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      systemAgent({ requestId, operation }),
      timeout,
    ]);
  } catch {
    return error('COLLECTION_FAILED', 'System Agent request failed');
  } finally {
    clearTimeout(timer);
  }
}

module.exports = orchestrate;
