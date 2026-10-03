function validSystemInfo(data) {
  return data !== null && typeof data === 'object' && !Array.isArray(data) &&
    typeof data.hostname === 'string' && typeof data.kernelRelease === 'string' &&
    Number.isInteger(data.cpuCount) && data.cpuCount > 0 &&
    Number.isInteger(data.totalMemoryBytes) && data.totalMemoryBytes >= 0 &&
    Number.isFinite(data.uptimeSeconds) && data.uptimeSeconds >= 0;
}

function supportsOperation(operation) {
  return operation === 'get_system_info';
}

// The supervisor checks the generic envelope before this operation contract.
function validOperationResponse(operation, response) {
  if (!supportsOperation(operation)) return false;
  return response.status === 'success' ? validSystemInfo(response.data) :
    ['INVALID_REQUEST', 'COLLECTION_FAILED'].includes(response.error.code);
}

module.exports = { supportsOperation, validSystemInfo, validOperationResponse };
