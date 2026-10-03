# ai-native-os

A minimal AI-native runtime/OS layer above Linux for supervising agents and
processes. v0.2 establishes deterministic process ownership and lifecycle
behavior before adding intelligence or resource enforcement.

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

## Deferred to v0.3

Cgroups, CPU/RAM limits, resource accounting, namespaces, and resource-aware
scheduling are outside v0.2. Host CPU/memory observations are not agent usage
measurements or allocation limits. A separate process under the same user is
not a security sandbox. Parent-death cleanup requires a responsive child;
process-tree supervision and stronger orphan guarantees are not implemented.

See [the architecture document](docs/architecture.md) for protocol and lifecycle
details.
