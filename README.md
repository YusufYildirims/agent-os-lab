# ai-native-os

A minimal AI-native runtime/OS layer above Linux for supervising agents and
processes. v0.3 adds a supervisor-owned Resource Manager, cgroup v2 discovery,
and opt-in allocation, PID placement, observation, and cleanup inside an
explicitly assigned delegated subtree. Memory/CPU/task limits remain deferred.

## Architecture and scope

The CLI owns an Orchestrator, which supervises one long-lived Node System Agent
through versioned IPC. Requests share startup, wait for readiness, and reuse the
same process. The only operation is `get_system_info`; it collects host
observations with Node's built-in `os` APIs.

The runtime provides bounded request admission, request/startup deadlines,
validated responses, failure metadata, explicit restart after failure, and
shutdown with SIGTERM/SIGKILL escalation. Operation contracts live beside the
agent; lifecycle and transport stay in the orchestrator. There are no external
runtime dependencies, LLM calls, arbitrary commands, or additional agents.

## Run and test

Use Node.js 24 or newer on Linux (including WSL2). No dependency installation is
required.

```sh
npm start -- system-info
npm test
```

Tests launch real subprocesses, read `/proc`, and exercise signals and IPC.
Run them in an environment that permits process creation and captured stdout.
The missing-entrypoint test intentionally emits a Node module-load error.

Programmatic use: `require('./src/core/orchestrator').createOrchestrator()`
returns `start()`, `request(operation, timeoutMs = 1000)`, `getAgentMetadata()`,
and `close()`. Always await `close()` when finished. Failed runtimes require an
explicit `start()` after cleanup; closed runtimes cannot restart.

## Resource Manager and delegated backend

Resource control defaults to `{ mode: 'disabled' }`, which performs no cgroup
inspection or writes. To expose read-only discovery in supervisor metadata:

```js
const { createOrchestrator } = require('./src/core/orchestrator');
const runtime = createOrchestrator({ resourcePolicy: { mode: 'observe' } });
try {
  await runtime.start();
  console.log(runtime.getAgentMetadata().resources);
} finally {
  await runtime.close();
}
```

Standalone discovery is available through
`require('./src/core/resource-manager').createResourceManager().inspect()`.
It reports current membership, the accessible cgroup v2 mount, controllers,
write accessibility, and enforcement blockers without mutating cgroups.
Writable files do not establish usable delegation. Observation mode is always
non-enforcing; shared cgroup counters are not exposed as agent usage.

Future policy fields are `memoryMaxBytes`, `cpuQuotaMicros`, `cpuPeriodMicros`
(default 100000 when a quota is supplied), and `pidsMax` (tasks, including
threads). Limits require `mode: 'enforce'`. Without usable explicit delegation, enforce mode fails with
`RESOURCE_ENFORCEMENT_UNAVAILABLE`. With delegation, requests containing limits
still fail with `RESOURCE_LIMITS_NOT_IMPLEMENTED`; they are never silently ignored.

An injected `resourceManager` can exercise asynchronous lifecycle behavior in
tests. Setup completes before agent initialization; final snapshots and disposal
complete before restart. Final snapshots have a 250 ms deadline, configurable
with `resourceSnapshotTimeoutMs`; observation failure or timeout does not prevent
disposal. `close()` waits for outstanding setup and disposal, which must settle.
Setup receives an optional AbortSignal, aborted on failure, exit, or close.
Cancellation is terminal in metadata; late allocations are still cleaned up.
Disposal failures remain visible and block restart. No resource state is added
to `get_system_info`.

A manager that cannot roll back a failed preparation must reject with
`ResourceSetupError`, exported from `src/core/resource-manager.js`, carrying
the surviving allocation and rollback error. Ownership then transfers to the
Orchestrator for normal cleanup. The original setup error and rollback/disposal
errors remain observable even if supervisor cleanup recovers the allocation.

## Stage 3: delegated allocation and observation

```js
const runtime = createOrchestrator({
  delegatedBasePath: '/sys/fs/cgroup/path/to/assigned-runtime.service',
  resourcePolicy: { mode: 'enforce' }, // Placement only; no limit fields yet.
});
try {
  await runtime.start();
  console.log(runtime.getAgentMetadata().resources);
} finally {
  await runtime.close();
  console.log(runtime.getAgentMetadata().resources.latestSnapshot);
}
```

The supplied base must be a writable, real cgroup v2 domain directory, empty of
its own processes, with `cpu memory pids` both available and already enabled in
`cgroup.subtree_control`. The supervisor must already run in a child leaf under
that base. The backend never enables controllers or moves the supervisor. It
rejects the global cgroup root, traversal, symlinked paths, and invalid topology.
A direct Resource Manager can be configured with the same `delegatedBasePath`.

Each instance gets a unique private `agent-...` leaf. Placement verifies a live
direct child and start-time identity around a synchronous `cgroup.procs` write,
then verifies membership. This reduces PID-reuse exposure; Node built-ins do not
provide atomic pidfd-based placement. It is not a security boundary against
concurrent same-user interference.

Runtime status `allocated` means placement completed; it never claims limits
are active. Cgroup snapshots have `enforcing: false` and include memory bytes
and events, CPU statistics, task count, and task events. Missing counters are
`null`; counts above JavaScript's safe integer range remain decimal strings.
Snapshots are available directly through the manager and retained at runtime
exit. `get_system_info` remains unchanged. Cleanup uses only non-recursive
`rmdir` after verifying ownership/identity and an unpopulated leaf; it never
kills processes or removes unrelated paths.

## Opt-in kernel integration test

Normal `npm test` uses virtual filesystem/backend tests and retains all real
process lifecycle tests. The kernel cgroup test skips unless an explicit path is
provided. A configured but invalid path fails the test rather than silently skips:

```sh
AI_NATIVE_OS_CGROUP_BASE=/sys/fs/cgroup/path/to/assigned-runtime.service npm test
```

Run this from a supervisor leaf **inside that assigned base**, with writable
cgroups. The current Codex execution mount is read-only, so it cannot run this
integration test. No sudo, remount, or host configuration changes are attempted.

On a normal WSL2 terminal with a working systemd user manager and systemd 254+
(the inspected installation is 259), the following is an explicit, manual launch
example. It creates a dedicated transient delegated unit; its shell enables
controllers only within the unit's assigned base. The backend itself does not
perform these provisioning steps. This command has not been run here:

```sh
systemd-run --user --wait --collect --pipe \
  --unit=ai-native-os-v03 \
  --property='Delegate=cpu memory pids' \
  --property='DelegateSubgroup=supervisor' \
  --working-directory=/home/yusuf/ai-native-os \
  /bin/bash -c '
    runtime_group=$(sed -n "s/^0:://p" /proc/self/cgroup)
    [ "${runtime_group##*/}" = supervisor ] || exit 1
    runtime_base="/sys/fs/cgroup${runtime_group%/supervisor}"
    printf "%s\n" "+cpu +memory +pids" > "$runtime_base/cgroup.subtree_control" || exit 1
    AI_NATIVE_OS_CGROUP_BASE="$runtime_base" npm test
  '
```

If the user manager cannot provide these controllers/delegation, an operator
must provision the assigned unit first; the runtime will report the missing
controller or placement/delegation blocker. These semantics follow the
[systemd delegation model](https://systemd.io/CGROUP_DELEGATION/).

## Deferred resource enforcement

Memory/CPU/task limit writes, swap policy, and continuous runtime usage sampling
remain deferred. Automated delegation/systemd provisioning, limits from process
birth, namespaces, and resource-aware scheduling are also outside this stage. A separate process under the same user is not a security
sandbox. Parent-death cleanup requires a responsive child; process-tree
supervision and stronger orphan guarantees are not implemented.

See [the architecture document](docs/architecture.md) for protocol and lifecycle
details.
