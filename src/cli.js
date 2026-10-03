const { createOrchestrator } = require('./core/orchestrator');

function runCli(args = process.argv.slice(2), runtime = createOrchestrator()) {
  let signalExitCode;

  const handlers = new Map(['SIGINT', 'SIGTERM'].map((signal) => [signal, () => {
    signalExitCode ??= signal === 'SIGINT' ? 130 : 143;
    process.exitCode = signalExitCode;
    void runtime.close();
  }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);

  function printError(response) {
    console.error(JSON.stringify(response, null, 2));
    process.exitCode = signalExitCode ?? 1;
  }

  async function main() {
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

    const response = await runtime.request('get_system_info');
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

  return main().finally(() => runtime.close()).catch(() => {
    printError({
      status: 'error',
      error: { code: 'COLLECTION_FAILED', message: 'Unable to retrieve system information' },
    });
  })
    .finally(() => {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    });
}

if (require.main === module) void runCli();
module.exports = { runCli };
