let systemAgent;

let instanceId;
let stopping = false;
const active = new Set();

function stop() {
  if (stopping) return;
  stopping = true;
  // Bound cleanup even if future asynchronous operation code fails to drain.
  const deadline = setTimeout(() => process.exit(0), 250);
  Promise.allSettled([...active]).then(() => {
    clearTimeout(deadline);
    process.exit(0);
  });
}

function send(message) {
  if (!process.connected) return stop();
  try {
    process.send(message, (error) => { if (error) stop(); });
  } catch {
    stop();
  }
}

process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('message', (message) => {
  if (stopping) return;
  if (!message || message.version !== 1 || typeof message.instanceId !== 'string') return stop();
  if (message.type === 'initialize' && !instanceId) {
    instanceId = message.instanceId;
    systemAgent = require('./system-agent');
    send({ version: 1, type: 'ready', instanceId });
    return;
  }
  if (message.instanceId !== instanceId) return stop();
  if (message.type === 'shutdown') return stop();
  if (message.type !== 'request') return stop();
  const { requestId, operation } = message;
  const work = systemAgent({ requestId, operation }).then((response) => new Promise((resolve) => {
    if (!process.connected) { stop(); resolve(); return; }
    process.send({ version: 1, type: 'response', instanceId, ...response }, (error) => {
      if (error) stop();
      resolve();
    });
  }));
  active.add(work);
  work.catch(stop).finally(() => active.delete(work));
});

if (!process.send) process.exitCode = 1;
