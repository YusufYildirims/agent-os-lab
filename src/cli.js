const orchestrate = require('./core/orchestrator');

function printError(response) {
  console.error(JSON.stringify(response, null, 2));
  process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== 'system-info') {
    printError({
      status: 'error',
      error: {
        code: 'INVALID_REQUEST',
        message: 'Usage: npm start -- system-info',
      },
    });
    return;
  }

  const response = await orchestrate('get_system_info');
  if (response.status === 'error') {
    printError(response);
    return;
  }

  const info = response.data;
  console.log([
    'System information',
    `Hostname: ${info.hostname}`,
    `Kernel release: ${info.kernelRelease}`,
    `CPU count: ${info.cpuCount}`,
    `Total memory: ${(info.totalMemoryBytes / 1024 ** 3).toFixed(2)} GiB (${info.totalMemoryBytes} bytes)`,
    `Uptime: ${Math.floor(info.uptimeSeconds)} seconds`,
  ].join('\n'));
}

main().catch(() => {
  printError({
    status: 'error',
    error: { code: 'COLLECTION_FAILED', message: 'Unable to retrieve system information' },
  });
});
