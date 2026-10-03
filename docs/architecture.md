# Agent OS Lab v0.2 Architecture

v0.2 is a deterministic userspace runtime above Linux. One Orchestrator owns
and supervises one long-lived System Agent Node process. No LLM, containers,
additional agents, cgroups, or resource limits are implemented.

```text
User -> CLI / Orchestrator process -> Node IPC -> System Agent process -> Linux
User <- CLI / Orchestrator process <- Node IPC <- System Agent process <- Linux
```

## Ownership and API

`createOrchestrator()` returns an independent runtime with `start()`,
`request(operation, timeoutMs = 1000)`, `getAgentMetadata()`, and `close()`.
Imports have no process-starting side effects. The first valid request starts
the agent lazily; concurrent startup callers share one startup promise.
Subsequent requests reuse the same child process. Constructor options require
an absolute agent path and integer startup/termination deadlines from 1 to
2147483647 ms; invalid configuration throws before spawning.

The Orchestrator uses `child_process.fork()` with an absolute entrypoint,
no shell, `detached: false`, and built-in IPC. The child remains referenced.
Child stdout is ignored, stderr is inherited, and IPC carries structured
messages independently of CLI output. The child never spawns descendants.

The child entrypoint installs lifecycle handlers, waits for initialization,
then loads the existing `system-agent.js` operation handler and reports ready.
No operation is dispatched before readiness. Startup has a separate five-second
timeout. An explicit initialization boundary allows future resource placement
before operation-handler loading without changing the request contract.

`npm start -- system-info` retains the v0.1 command and human-readable output.
The CLI owns its runtime, closes it in `finally`, and initiates the same cleanup
on SIGINT or SIGTERM. Signal exit codes (130 and 143) take precedence over
pending-request errors. CLI imports do not execute commands or install handlers.

## IPC protocol

All transport messages use `version: 1`. Each child lifetime has a unique
`instanceId`; each request has a unique UUID `requestId`.

Parent initialization and child readiness:

```json
{"version":1,"type":"initialize","instanceId":"instance-a"}
```

```json
{"version":1,"type":"ready","instanceId":"instance-a"}
```

Request and success response:

```json
{
  "version": 1,
  "type": "request",
  "instanceId": "instance-a",
  "requestId": "req-1",
  "operation": "get_system_info"
}
```

```json
{
  "version": 1,
  "type": "response",
  "instanceId": "instance-a",
  "requestId": "req-1",
  "status": "success",
  "data": {
    "hostname": "linux-host",
    "kernelRelease": "6.8.0",
    "cpuCount": 4,
    "totalMemoryBytes": 8589934592,
    "uptimeSeconds": 1200
  }
}
```

An operation failure has `status: "error"` and an `error` object instead of
`data`, retaining `INVALID_REQUEST` or `COLLECTION_FAILED` from v0.1.
Shutdown is `{version: 1, type: "shutdown", instanceId}`.

Public responses retain `{requestId, status, data | error}`; transport fields
are not exposed as operation results. The operation still accepts no parameters
or arbitrary commands. The Orchestrator validates generic response envelopes,
then delegates operation validation to `system-agent-contract.js` before resolving callers. The collector
uses the same system-info data validator.

A pending-request Map holds each resolver and deadline. Responses may arrive
out of order; they are matched by request ID within the current process
instance and settled exactly once. Valid duplicate or unknown responses are
ignored after generic envelope validation. Malformed envelopes, wrong-instance
messages, or invalid operation data for a pending request fail the process.
There is a maximum of 64 pending requests, including startup waiters; excess
requests return `AGENT_BUSY`. Multiple pending requests do not mean parallel
execution: the current collector runs synchronously on one child event loop.
IPC send failures trigger cleanup; a backpressure return value is not retried.

## Lifecycle and failure policy

States are `STOPPED`, `STARTING`, `READY`, `STOPPING`, `FAILED`, and `CLOSED`.

```text
STOPPED -> STARTING -> READY
              |         |
              +---------+-> STOPPING -> FAILED
FAILED -> STARTING                 (explicit start only)
any live state -> STOPPING -> CLOSED  (close)
STOPPED / FAILED -> CLOSED
```

A collection error leaves the process ready. Unexpected exit, IPC disconnect,
protocol error, or startup failure makes the agent unavailable. If a disconnected
child is still alive, the parent terminates it. Outstanding calls settle when
exit is observed, with the recorded failure. Crash event ordering can produce
`AGENT_EXITED` or `AGENT_DISCONNECTED`; exit metadata records the actual outcome.

There are no automatic restart loops or request retries. After failure,
`request()` returns `AGENT_UNAVAILABLE`; the caller may explicitly `start()`
after the previous child exits. No replacement overlaps a stopping process.
`close()` permanently prevents restart and is idempotent.

### Deadlines and actual termination

The request deadline starts on acceptance, including startup wait time.
A request expiring before dispatch returns `TIMEOUT` without terminating the
child. A dispatched request expiring marks that request timed out and terminates
the entire agent. Other pending callers receive `AGENT_TERMINATED`.

Termination sends SIGTERM first, then SIGKILL after 500 ms if exit has not been
observed. A timed-out dispatched call resolves only after the child `exit` event;
a successful signal send or `child.killed` is never treated as proof of exit.
The elapsed call time can therefore exceed its operation deadline while cleanup
finishes. The first failure wins; response/timeout/disconnect races do not settle
a request twice. Timers are cleared during settlement and exit cleanup.

### Clean shutdown and orphan prevention

`close()` rejects outstanding operations with `RUNTIME_CLOSED`, sends a shutdown
message, and waits for child exit. It allows 500 ms for cooperative shutdown,
then uses the SIGTERM/SIGKILL termination path if necessary. It resolves only
after exit is confirmed. Pending calls are not guaranteed successful completion
once shutdown begins.

The child briefly drains active response sends during cooperative shutdown,
with a 250 ms bound. It also exits on IPC disconnect, SIGTERM, or SIGINT.
The parent always retains ownership during cleanup; normal shutdown leaves
no running child. A responsive child exits if its parent dies abruptly.

Node built-ins cannot guarantee orphan prevention when a parent is killed
while its child is blocked in synchronous code. A kernel parent-death mechanism
or external supervisor would be needed for that guarantee. SIGKILL also cannot
guarantee a fixed exit deadline for a process stuck in uninterruptible kernel
sleep; the runtime continues waiting rather than falsely reporting termination.

## Metadata and future resource management

The metadata snapshot contains agent ID, process-instance ID, lifecycle state,
Orchestrator PID, child PID, startup/readiness/exit timestamps, pending count,
exit code, terminating signal, termination reason, and signal-delivery errors.
Normal close records `RUNTIME_CLOSED`; unexpected exit always records a reason.
The first failure survives later close. Failed signal delivery is recorded
without treating it as exit; SIGTERM failure still escalates to SIGKILL. If
SIGKILL fails, ownership and exit waiting continue until actual exit is observed.
A fresh instance ID separates restarted lifetimes. No mutable ChildProcess handle is exposed publicly.

For v0.3, keep the Orchestrator outside the agent cgroup. Insert cgroup creation,
limit configuration, and PID placement before sending `initialize`. This gates
operation code, but not Node's earliest bootstrap allocations; strict limits
from process birth would require adapting the launch mechanism.

Collect CPU and memory measurements from the supervisor using Linux process
or cgroup interfaces, rather than trusting child-reported metrics. Add Linux
process-start identity checks when sampling because PIDs can be reused. Extend
metadata with resource policy and cgroup location, and collect final counters
before cgroup cleanup. A future process-tree policy must also extend termination
beyond the single child if descendants become permitted.

`get_system_info` still returns host/system observations through Node's `os`
interfaces. CPU count and total memory are not agent usage metrics or allocated
resource limits. Separate processes provide memory/process isolation under the
same user privileges, not a security sandbox or least-privilege enforcement.

## Verification

Existing collector tests retain validation, collection-error, and invalid-data
coverage. Runtime tests fork real children to verify IPC, distinct PIDs and
Linux parentage, process reuse, concurrent out-of-order matching, deadlines,
SIGKILL escalation, crashes, disconnects, malformed responses, clean shutdown,
startup failure, explicit restart, admission overflow, expiration before dispatch,
wrong-instance messages, duplicate/unknown responses, injected send/signal
failures, and response/timeout/close ordering. CLI tests check command output,
errors, signal exit codes, and child self-exit after abrupt parent death.
Test fixtures are excluded from automatic test-file discovery by the npm test command.
