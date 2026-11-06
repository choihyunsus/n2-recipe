# N2R · n2-recipe

Mandatory lifecycle checks and durable execution for host-controlled AI workflows.

[한국어 안내](README.ko.md)

N2R reads `.n2r` recipes through the published Clotho compiler and executes their registered tools in order. A normal workflow follows boot, preparation, work, verification and final checkpointing. The host supplies the actual preparation, work and verification implementations. Registered work tools remain available throughout the work callback.

An agent coordinator such as Gumiho can use one N2R run for a logical task containing many model turns and tool calls. A completed run has an immutable result, scoped execution evidence and one corresponding experience in the common Soul database.

## Install

Requires Node.js 22 or later. SQLite uses `better-sqlite3`, with optional compatible Mimir Rust bindings. Installation may require a native build toolchain when a prebuilt SQLite binding is unavailable.

```sh
npm install https://github.com/choihyunsus/n2-recipe/releases/download/v1.0.0/n2-recipe-1.0.0.tgz
```

This version is distributed through GitHub Releases. Clotho, Mimir and Personas are pinned to published GitHub artifacts in the dependency manifest.

## Host integration

```js
import { RecipeRunner } from 'n2-recipe';

const runner = new RecipeRunner({
  dbPath: './data/soul.db',
  project: 'example-project',
  agent: 'worker',
  tools: [
    {
      name: 'prepare',
      version: '1',
      readOnly: true,
      execute: async (args, context) => host.prepare(args.task, context.signal),
    },
    {
      name: 'edit',
      version: '1',
      execute: async (args, context) => host.edit(args, context),
    },
    {
      name: 'verify',
      version: '1',
      readOnly: true,
      execute: async (args, context) => host.verify(args.files, context.signal),
    },
  ],
});

try {
  const receipt = await runner.run(
    { runId: 'request-001', sessionId: 'session-001', task: 'Implement the requested change' },
    {
      version: '1',
      execute: async context => {
        await context.callTool('edit', { task: context.context.prompt });
        return { success: true, output: 'Work callback finished' };
      },
    },
  );
  console.log(receipt.success, receipt.experienceId);
} finally {
  await runner.close();
}
```

`host` represents your application's own implementations. Each tool returns an explicit `success` boolean, `output` text, optional JSON `data` and optional `modifiedFiles`. Report known operational failures with `success: false`. An exception or timeout leaves an uncertain pending invocation for recovery.

Register meaningful checks before use. The bundled `prepare` and `verify` names must resolve to host handlers. A required failure or a skipped-over required step prevents phase success. A diagnostic recovery step preserves the earlier failure. A conditional required step can be inapplicable after its condition is reached. Goto loops are bounded.

## Bundled phases

| Phase | Default behavior |
| --- | --- |
| `boot` | Recall up to four historical successes owned by the current project and agent |
| `work_start` | Run host preparation, then select bounded generic task expertise |
| Work callback | Allow calls to all registered tools and collect reported changed files |
| `work_end` | Invoke host verification with task text and the changed-file array |
| `end` | Save the scoped workflow checkpoint |

Preparation failure prevents the work callback. Known work failure still runs post-work verification. Known phase failures still reach the final checkpoint phase. An interruption preserves the pending operation and resumes its original lifecycle order.

Final success requires all four phases and the work callback to pass. The host defines verification depth, including test commands, artifact hashes, file discovery and sandboxing. Tool callbacks receive an `AbortSignal`, stable `runId` and stable `callId`. The host must enforce its own filesystem, network and subprocess permissions.

## Recovery and concurrency

- Repeating a completed run ID with identical input, tool versions and work-handler version returns its recorded result.
- Each unfinished run retains its original recipe snapshot. New recipe revisions apply to new runs.
- Completed child calls are reused during an idempotent work replay. Diverging arguments or omitted prior calls fail explicitly.
- A pending call can replay when its handler declares `idempotent: true`. Read-only tools default to idempotent. Work callbacks default to requiring reconciliation.
- A host can inspect external effects and call `reconcileCall(runId, callId, result, evidenceNote)`. Resolve pending child calls before reconciling the whole work callback. Post-work verification still runs.
- The project/agent scope has one active lease. Dead processes and expired leases can be replaced. Nonce checks prevent an old owner from committing after replacement.
- External effects require handler-level idempotency or reconciliation. An uncooperative callback can continue running after cancellation, so isolate it in a host-owned process when necessary.

```js
const pending = runner.status('request-001');
// Inspect the external effect and supply the result established by that inspection.
runner.reconcileCall('request-001', 'work:0', inspectedResult, evidenceNote);
const resumed = await runner.run(originalRequest, originalVersionedHandler);
```

The final result and its Mimir experience commit in one SQLite transaction. A failed finalization can retry from completed phase receipts. Interrupted work remains in the execution ledger until resolved.

## Task expertise

The default selector scores metadata from the 72 published generic Personas profiles using BM25 and exact token triggers. A match adds domain guidance to the work context. Empty and unmatched tasks add no profile. Guidance has an 8 KiB ceiling and an approximate 1,200-token heuristic budget.

Configure `expertise: false` to disable selection, or `expertise: { personaId: 'dev/web-frontend' }` for a fixed profile. A custom selector supplies `{ version, select(task, profiles, signal) }` and returns a catalogued ID or `null`. Its version participates in replay identity.

The standalone selector scans the small published catalog directly. Daebung's integrated version routes persona metadata through Hecaton's broader taxonomy and DNA filtering pipeline. Hosts can supply their own selector to integrate that routing policy.

## Recipes

```n2
@meta { name: "work_end" phase: "work_end" version: "1.0.0" }
@recipe WorkEnd {
  enforce: strict
  step verify {
    tool: "verify"
    args_json: "{\"files\":\"${modified_files_array}\"}"
    required: true
    on_fail: abort
  }
}
```

A complete bundle supplies `boot.n2r`, `work_start.n2r`, `work_end.n2r` and `end.n2r`. Each phase requires strict enforcement and an unconditional required check. `parseRecipe` exposes parsing separately for inspection.

Supported step fields are `tool` or legacy `action`, `args` or `args_json`, `required`, `inject`, `condition`, `on_fail` and legacy `unlock` metadata. Injection targets are `system_prompt`, `user_message`, `none` or a context variable. Conditions use `if ${variable}`, including `has_code_changes` and `last_step_failed`. Failure actions are `abort`, `skip` and `goto step_name`.

`${prompt}`, `${last_failure}`, `${modified_files}` and `${modified_code_files}` preserve legacy text substitution. `${modified_files_array}` and `${modified_code_files_array}` produce typed arrays when used as an entire string value. Inserted text is processed once. Legacy `unlock` data is retained as recipe metadata, while actual tool availability follows host registration.

`runner.updateRecipe(phase, source, expectedHash)` permits edits to `work_start` and `work_end`. Configured baseline checks retain their definitions and relative order. Retrieve the current hash with `runner.recipes()`. Boot and end are configured through the initial bundle. Use a separate agent scope for a different baseline.

## CLI

```sh
n2-recipe validate
n2-recipe validate --recipes ./recipes
n2-recipe status --db ./data/soul.db --project demo --agent worker --run-id demo-001
n2-recipe run --adapter ./adapter.cjs --db ./data/soul.db --project demo --agent worker --run-id demo-001 --task "Write the requested output"
```

An operator-selected local CJS or ESM adapter exports `tools`, `work` and optional `recipes`, `expertise` and `deadlines`. Loading it executes local JavaScript with the host process permissions. CLI status opens an existing database read-only. Exit codes are 0 for a successful command, 1 for an execution/configuration error and 2 for a completed workflow whose checks failed.

The packaged `examples/file-task.cjs` performs a real file write and content/hash verification. Set `N2R_DEMO_DIR` to an existing scratch directory before loading it. It writes `answer.txt` there. Use a fresh run ID for a new logical task.

## Shared Soul storage

Point the runner at the same local SQLite file used by the distribution Soul/Mimir. Ownership always includes `project` and `agent`, with `session_id` retained on runs and experiences. The common memory schema comes from Mimir 3.0.3.

N2R adds `n2r_configuration`, `n2r_runs`, `n2r_calls`, `n2r_leases` and `n2r_checkpoints`, tracked by `meta.n2r_schema_version = 1`. Existing unversioned N2R tables require an explicit migration. Scoped execution records retain recipe hashes, arguments, results and reconciliation notes. Keep credentials in adapter closures and environment variables. Store task data in invocation arguments and outputs.

## Bounds

| Resource | Limit/default |
| --- | --- |
| Recipe source / steps | 64 KiB per phase / 64 steps |
| Phase iterations | Three times its step count |
| JSON nesting / input elements | 16 levels / 4,096 elements |
| Tool arguments / output text / data | 64 KiB / 64 KiB / 16 KiB |
| Result / context / prompt addition | 128 KiB / 256 KiB / 8 KiB |
| Run calls / durable call trace | 2,048 / 8 MiB, including pending result reservations |
| Queued work argument data | 512 KiB, executed sequentially |
| Tool / phase / work deadlines | 30 seconds / 120 seconds / 300 seconds |
| Configurable deadline range | 1 millisecond through 1 hour |
| Lease / heartbeat | 30 seconds / 10 seconds |

Deadlines race asynchronous callbacks and propagate cancellation. Synchronous CPU work requires host process isolation to impose a hard execution limit. Resource-limit errors preserve already recorded effects. Inspect an interrupted run before choosing its recovery action.

## Development

```sh
npm ci
npm test
npm run typecheck
```

Tests exercise real writes, verification failures, recipe updates, forced process termination, uncertain side effects, replay divergence, lease replacement, transaction rollback, generic expertise and CLI integration. Published archives are checked through fresh consumers as part of release verification.

## License

The N2R implementation is MIT licensed. Clotho and Mimir retain their separate noncommercial/commercial license terms. Review the bundled dependency licenses and `THIRD-PARTY-NOTICES` for redistribution and commercial use.
