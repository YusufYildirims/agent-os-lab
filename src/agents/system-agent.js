const os = require('node:os');

async function systemAgent(request) {
  const requestId = request?.requestId ?? null;
  const error = (code, message) => ({
    requestId,
    status: 'error',
    error: { code, message },
  });

  if (
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    typeof requestId !== 'string' ||
    requestId.trim().length === 0
  ) {
    return error('INVALID_REQUEST', 'requestId must be a nonempty string');
  }

  if (request.operation !== 'get_system_info') {
    return error('INVALID_REQUEST', 'Only get_system_info is supported');
  }

  if (Object.keys(request).some((key) => !['requestId', 'operation'].includes(key))) {
    return error('INVALID_REQUEST', 'get_system_info takes no parameters');
  }

  try {
    const data = {
      hostname: os.hostname(),
      kernelRelease: os.release(),
      cpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      uptimeSeconds: os.uptime(),
    };

    if (
      typeof data.hostname !== 'string' ||
      typeof data.kernelRelease !== 'string' ||
      !Number.isInteger(data.cpuCount) || data.cpuCount < 1 ||
      !Number.isInteger(data.totalMemoryBytes) || data.totalMemoryBytes < 0 ||
      !Number.isFinite(data.uptimeSeconds) || data.uptimeSeconds < 0
    ) {
      return error('COLLECTION_FAILED', 'Unable to read system information');
    }

    return { requestId, status: 'success', data };
  } catch {
    return error('COLLECTION_FAILED', 'Unable to read system information');
  }
}

module.exports = systemAgent;
