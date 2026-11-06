const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ToolRegistry, checkedToolResult } = require('../dist/tool-registry');
const { withDeadline, InterruptedExecution } = require('../dist/deadline');

function context() {
  return {
    project: 'fixture',
    agent: 'worker',
    runId: 'run',
    callId: 'call',
    phase: 'work',
    signal: new AbortController().signal,
  };
}

test('all registered tools remain available and definitions, arguments and results are isolated', async () => {
  const definition = {
    name: 'work.inspect',
    version: '1',
    readOnly: true,
    execute(args, context) {
      assert.equal(context.project, 'fixture');
      args.changed = true;
      return { success: true, output: 'inspected', data: { trace: 1 } };
    },
  };
  const registry = new ToolRegistry([definition]);
  definition.version = 'mutated outside';
  assert.equal(registry.get('work.inspect').version, '1');
  assert.equal(registry.list()[0].idempotent, true);
  const args = { unchanged: true };
  assert.equal((await registry.invoke('work.inspect', args, context())).success, true);
  assert.deepEqual(args, { unchanged: true });
  assert.throws(() => registry.get('missing'), /registered/);
  assert.throws(() => new ToolRegistry([definition, definition]), /duplicate/);
});

test('malformed results and contradictory read-only mutations produce explicit failures', async () => {
  assert.throws(() => checkedToolResult({ success: 'true', output: 'claim' }), /boolean/);
  assert.throws(() => checkedToolResult({ success: true, output: 'x'.repeat(65537) }), /output/);
  assert.throws(
    () => checkedToolResult({ success: true, output: 'ok', data: new Date() }),
    /plain JSON/,
  );
  const registry = new ToolRegistry([
    {
      name: 'read',
      version: '1',
      readOnly: true,
      execute: () => ({ success: true, output: 'changed', modifiedFiles: ['source.ts'] }),
    },
  ]);
  await assert.rejects(registry.invoke('read', {}, context()), /mutations/);
});

test('referenced deadlines and cancellation settle uncooperative callbacks', async () => {
  await assert.rejects(
    withDeadline(() => new Promise(() => {}), 10),
    InterruptedExecution,
  );
  const controller = new AbortController();
  const pending = withDeadline(() => new Promise(() => {}), 1000, controller.signal);
  const rejected = assert.rejects(pending, /cancelled/);
  controller.abort();
  await rejected;
  let called = false;
  await assert.rejects(
    withDeadline(
      () => {
        called = true;
      },
      1000,
      controller.signal,
    ),
    /before/,
  );
  assert.equal(called, false);
  assert.equal(await withDeadline(() => 'complete', 1000), 'complete');
});
