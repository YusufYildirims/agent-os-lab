# Agent OS Lab v0.3 Architecture

v0.3 extends the deterministic v0.2 runtime with a supervisor-owned Resource
Manager and an explicitly delegated cgroup v2 backend. One Orchestrator
supervises one long-lived System Agent Node process. Cgroup allocation,
placement, observation, and removal are implemented; resource limit writes,
LLMs, containers, and additional agents are not.

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
timeout covering resource preparation, spawning, attachment, and readiness.
Preparation must complete before spawning; attachment must complete before
initialization. The delegated backend places the child before initialization;
disabled and discovery modes perform no placement.

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
child is still alive, the parent terminates it. Outstanding dispatched calls
settle after exit and resource cleanup, with the
recorded failure. If preparation fails before a child exists, calls may settle
before resource cleanup completes; metadata retains the `STOPPING` state until
cleanup is resolved. Crash event ordering can produce
`AGENT_EXITED` or `AGENT_DISCONNECTED`; exit metadata records the actual outcome.

There are no automatic restart loops or request retries. After failure,
`request()` returns `AGENT_UNAVAILABLE`; the caller may explicitly `start()`
after the previous child exits and resource cleanup finishes. An explicit
`start()` during post-exit cleanup waits for cleanup before attempting restart;
it still rejects while a child is terminating. No replacement overlaps a
stopping process or unresolved resource operation. A disposal failure blocks
restart with `RESOURCE_CLEANUP_FAILED`. Snapshot failure alone does not block
restart if disposal succeeds.
`close()` permanently prevents restart and is idempotent.

### Deadlines and actual termination

The request deadline starts on acceptance, including startup wait time.
A request expiring before dispatch returns `TIMEOUT` without terminating the
child. A dispatched request expiring marks that request timed out and terminates
the entire agent. Other pending callers receive `AGENT_TERMINATED`.

Termination sends SIGTERM first, then SIGKILL after 500 ms if exit has not been
observed. A timed-out dispatched call resolves only after the child `exit` event
and resource cleanup; a successful signal send or `child.killed` is never
treated as proof of exit.
The elapsed call time can therefore exceed its operation deadline while cleanup
finishes. The first failure wins; response/timeout/disconnect races do not settle
a request twice. Timers are cleared during settlement and exit cleanup.

### Clean shutdown and orphan prevention

`close()` rejects outstanding operations with `RUNTIME_CLOSED`, sends a shutdown
message, and waits for child exit. It allows 500 ms for cooperative shutdown,
then uses the SIGTERM/SIGKILL termination path if necessary. It resolves only
after exit is confirmed and resource cleanup finishes. Pending calls are not
guaranteed successful completion once shutdown begins.

The child briefly drains active response sends during cooperative shutdown,
with a 250 ms bound. It also exits on IPC disconnect, SIGTERM, or SIGINT.
The parent always retains ownership during cleanup; normal shutdown leaves
no running child. A responsive child exits if its parent dies abruptly.

Node built-ins cannot guarantee orphan prevention when a parent is killed
while its child is blocked in synchronous code. A kernel parent-death mechanism
or external supervisor would be needed for that guarantee. SIGKILL also cannot
guarantee a fixed exit deadline for a process stuck in uninterruptible kernel
sleep; the runtime continues waiting rather than falsely reporting termination.

## Metadata and resource management

The metadata snapshot contains agent ID, process-instance ID, lifecycle state,
Orchestrator PID, child PID, startup/readiness/exit timestamps, pending count,
exit code, terminating signal, termination reason, and signal-delivery errors.
Normal close records `RUNTIME_CLOSED`; unexpected exit always records a reason.
The first failure survives later close. Failed signal delivery is recorded
without treating it as exit; SIGTERM failure still escalates to SIGKILL. If
SIGKILL fails, ownership and exit waiting continue until actual exit is observed.
A fresh instance ID separates restarted lifetimes. No mutable ChildProcess handle is exposed publicly.

The `resources` metadata field contains a defensive copy of the normalized
requested policy, enforcement status, discovery capabilities, latest final
snapshot, setup error, cleanup errors, cleanup status, and disposal-failure flag.
Before startup its cleanup status is `idle`; during a lifetime it is `pending`,
then `running`, then `complete` or `failed`. Enforcement status is `disabled`,
`observe`, `pending`, `cancelled`, `unavailable`, or `allocated`. The Stage 3
backend reports `allocated` after placement, not active resource limits. A
future enforcing backend may report `enforced` after attachment succeeds.

### Policy and manager contract

`createOrchestrator({ resourcePolicy, resourceManager })` validates policy and
manager methods before any process creation. Policy mode defaults to `disabled`;
other modes are `observe` and `enforce`. Optional limits are positive safe
integers: `memoryMaxBytes`, `cpuQuotaMicros`, `cpuPeriodMicros`, and `pidsMax`.
Limits require enforce mode. A period requires a quota; its default is 100000
microseconds. These are foundation policy fields, not applied kernel settings.
Kernel-specific bounds and swap policy belong to the enforcement stage.

The small manager interface permits synchronous values or promises:

- `inspect()` returns read-only capability facts.
- `prepare(instanceId, policy, { signal })` returns an allocation object
  containing `enforcementStatus` matching the requested mode, or `allocated`
  for enforce mode without any limit fields (`enforced` for future actual
  limits), and optional `capabilities` and `cgroupPath`. A rejection without a surviving
  allocation means prepare has created nothing or fully rolled it back.
- `attach(allocation, pid, { signal })` must complete before `initialize` is sent.
  Attachment is never called without a positive integer PID. The optional
  AbortSignal context supports cooperative setup cancellation without adding
  manager methods. Existing managers may ignore the extra argument.
- `snapshot(allocation)` returns cloneable supervisor observations or `null`.
- `dispose(allocation)` resolves only when its allocation is released.

`ResourceSetupError` is exported from `src/core/resource-manager.js`:

```js
throw new ResourceSetupError(setupError, {
  allocation: survivingAllocation,
  rollbackError,
});
```

It uses code `RESOURCE_SETUP_FAILED` and retains the original error as `cause`.
Allocation and rollback error are optional, but a rollback failure requires a
surviving allocation handle. The supervisor adopts that handle even after
cancellation, records `setupError.originalError` and a cleanup error with phase
`rollback`, and attempts snapshot/disposal normally. Successful disposal resolves
ownership; the historical rollback error stays visible but does not by itself
make cleanup failed. Failed disposal records phase `dispose`, marks
`disposalFailed`, and blocks restart. Ordinary setup failures can still reject
with a plain Error when nothing survives.

Without delegation, the manager prepares logical allocations only. Disabled mode avoids
filesystem reads. Observe mode inspects `/proc/self/cgroup`,
`/proc/self/mountinfo`, and the current cgroup's controller files, accounting for
mount roots and escaped mount paths. A read-only mount blocks writability even
when its underlying superblock is writable. Directory and delegation-file
access checks are read-only; they do not establish permitted migration,
controller topology, or systemd delegation. Enforcement availability remains
false because resource limit writes are not implemented. `allocationAvailable`
and the `delegated` facts separately report whether placement can be used. Discovery errors
are returned as blockers, so observe mode can run without usable cgroups.

The latest snapshot is collected at exit, before disposal. Observe-mode
snapshots contain discovery facts and `enforcing: false`, not agent usage.
Delegated snapshots contain the allocated leaf's real controller counters and
still identify themselves as non-limiting (`enforcing: false`). Ready-time discovery is exposed through `capabilities`; there is no
periodic sampler or live usage API in this stage.

### Setup, cancellation, and cleanup ownership

The startup timer begins before preparation. Setup failure or timeout rejects
`start()` with a meaningful error code, preserves the first lifecycle failure,
and terminates any spawned child using the existing signal escalation.
Initialization is gated on successful attachment and a still-active instance.
Close or timeout prevents late preparation/attachment from spawning or
initializing an agent. A late returned allocation is still owned and disposed.

Child exit and resource completion have separate promises. Cleanup waits for
both actual child exit (or confirmation that no child was spawned) and pending
setup settlement. It attempts one final snapshot, then disposal even if the
snapshot fails or exceeds `resourceSnapshotTimeoutMs` (default 250 ms, a
positive integer up to 2147483647). Timeout records `RESOURCE_SNAPSHOT_TIMEOUT`.
Late snapshot results are ignored, and late rejections remain handled. A timed
out observational read may still finish after disposal; snapshot must perform
no writes. Disposal itself has no abandonment deadline and remains authoritative
for allocation release. Errors are retained separately from the original termination
reason. `close()` resolves after cleanup attempts, including failed disposal;
callers must inspect cleanup metadata for success. No automatic disposal retry
is implemented, and failed disposal permanently blocks restart of that runtime.

Setup receives one AbortSignal per instance, aborted on failure, exit, or
close. Abort is cooperative: the supervisor still waits for setup settlement and
adopts late allocations or typed errors. Managers must check cancellation before
side effects and transfer any surviving allocation on rejection. Cancellation
before initialization ends with status `cancelled` when close is the first
lifecycle failure; other setup failures end with `unavailable`.

Startup rejection is bounded by the startup timer, but `close()`, failed
dispatched requests, and restart can wait indefinitely for unresolved setup or
disposal, just as actual process exit can remain pending. Snapshot observation
alone cannot keep disposal pending. Retaining ownership avoids abandoning a
possible late allocation. Injected managers are trusted supervisor components
and must settle operations and return cloneable metadata.

On child exit, all pending request deadlines stop immediately. Timeouts already
observed remain timeouts; subsequent snapshot/disposal latency cannot change an
exit failure into a request timeout. Requests still await cleanup where required.
Concurrent restart callers share the cleanup barrier and next startup; close
while they wait prevents a replacement instance.

### Delegated cgroup v2 backend

`createOrchestrator({ delegatedBasePath, resourcePolicy: { mode: 'enforce' } })`
configures the default manager's real backend. `createResourceManager` accepts
the same explicit path. No environment variable silently enables runtime
allocation; `AI_NATIVE_OS_CGROUP_BASE` is only an opt-in test setting.

The assigned base must exist, resolve without symlink components, be on cgroup2
(checking mount information and filesystem magic), and permit directory creation
and writes to `cgroup.procs`. The global cgroup root is refused. Required core
files must exist and be readable. The base must be an empty `domain` node with
`cpu`, `memory`, and `pids` present in both `cgroup.controllers` and
`cgroup.subtree_control`. The supervisor's current membership must be in a
child leaf under the base, permitting migration within the delegation boundary.
The backend never enables controllers, modifies ancestors, or moves the parent.
Precise validation blockers appear in discovery capabilities.

Preparation validates cancellation and safe instance names, then creates one
exclusive leaf with an instance name and random UUID. It registers a private
allocation record immediately after creation and checks the new leaf's files,
controllers, identity, and empty state. Failure attempts normal disposal;
failed rollback transfers the registered handle through `ResourceSetupError`.
Failure before successful mkdir never removes an existing directory. Allocation
handles are frozen and authenticated through a private WeakMap; paths alone do
not grant ownership. Base and leaf device/inode identities are rechecked before
subsequent operations.

Attachment accepts only positive integer PIDs. It reads Linux process stat
(including start time and parent PID) and source membership, restricting
placement to live direct children within the delegated base. It opens only the
owned leaf's `cgroup.procs`, without create/truncate or symlink following,
rechecks cancellation and identity, makes one PID write, and verifies identity
and membership afterward. The final checks and write are synchronous to avoid
an event-loop gap; external process death/reuse cannot be made fully atomic
without a stronger native launch/placement mechanism. This is not protection
against concurrent same-user interference.

Snapshot fields are `memory.currentBytes`, `memory.events`, `cpu.stat`,
`pids.current`, and `pids.events`, with group path and sampling time. Values are
nonnegative integers; decimal strings preserve counts beyond the safe integer
range. Missing optional files produce `null`, while malformed or inaccessible
counters fail observation. No usage API is added to the agent IPC operation.
Small synchronous kernel-file reads are used; the snapshot timer bounds pending
promises but cannot preempt synchronous JavaScript or kernel I/O.

Disposal verifies the authenticated record and directory identities, then reads
`cgroup.events` and `cgroup.procs`. It only calls non-recursive rmdir when
`populated` is zero and no processes are listed. The kernel remains authoritative
if a task/child appears between check and removal. Existing descendants, stale
identities, access failures, or populated groups produce cleanup errors and
block restart. No process killing, recursive removal, or re-adoption of foreign
paths is attempted. Repeated disposal of an already removed owned handle is
idempotent.

### Stage 4 and later

First run the opt-in real integration test in a writable dedicated delegated
unit; see README for the external systemd launch example. Then add validated
memory limits, an explicit swap policy, and OOM/event evidence behind the same
manager lifecycle. Follow with CPU quota/period and task limits. Explicit limit
fields currently fail with `RESOURCE_LIMITS_NOT_IMPLEMENTED` before allocation;
no limits are claimed active. Ancestor ceilings must remain observable.

Post-fork placement does not cover Node bootstrap allocations or move previously
charged memory. Strict limits from process birth require changing launch.
Descendant support also needs group-wide termination rather than single-child
signals. Neither provisioning nor these stronger guarantees is implemented.

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

Resource tests use an injected manager and a read/access-only filesystem fake.
They cover disabled/observe modes, policy validation, mount-root mapping,
missing cgroups/controllers, permission blockers, preparation and attachment
ordering/failures, setup deadlines, cancellation and late allocations, final
snapshots, disposal failure, cleanup-gated restart, enforcement rejection, and
defensive metadata copies. Regression cases also cover exit-before-disconnect
and deadline ordering, partial-allocation transfer and failed rollback, bounded
snapshots and late results/rejections, absent spawn PIDs, unexpected exit during
attachment, multiple restart waiters, and cancellation of waiting restarts.
Writable cgroups are not needed.

Backend tests use a virtual cgroup filesystem to cover delegated mount/path
validation, controller/topology blockers, unique allocations, traversal, failed
rollback transfer, cancellation, PID identity and membership verification,
counter parsing, populated/foreign/replaced groups, and non-recursive cleanup.
The opt-in kernel test validates actual membership and final removal; without
explicit delegation it reports an intentional skip.
