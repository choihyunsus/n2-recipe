const { test } = require('node:test');
const assert = require('node:assert/strict');
const { expertiseTool, matchExpertise } = require('../dist/expertise');
const { ToolRegistry } = require('../dist/tool-registry');
const { withDeadline } = require('../dist/deadline');
const { RecipeRunner } = require('../dist/library');

const context = () => ({
  project: 'demo',
  agent: 'worker',
  runId: 'expert',
  callId: 'work_start:1',
  phase: 'work_start',
  signal: new AbortController().signal,
});
const invoke = (option, task) =>
  new ToolRegistry([expertiseTool(option)]).invoke('n2r_expertise', { task }, context());

test('catalog BM25 selects bounded frontend guidance and unrelated or empty tasks remain unmatched', async () => {
  const catalog = await import('n2-personas');
  assert.equal(catalog.listPersonas().length, 72);
  assert.equal(
    matchExpertise('react css typescript frontend', catalog.listPersonas()).id,
    'dev/web-frontend',
  );
  assert.equal(matchExpertise('zzzzqqqxxxyyy', catalog.listPersonas()), undefined);
  assert.equal(matchExpertise('', catalog.listPersonas()), undefined);
  const result = await invoke(undefined, '한'.repeat(19) + ' react css typescript frontend');
  assert.equal(result.data.personaId, 'dev/web-frontend');
  assert.match(result.output, /Task Expertise/);
  assert.match(result.output, /alongside the configured identity/);
  assert.ok(Buffer.byteLength(result.output) <= 8192);
  assert.ok(
    [...result.output].reduce((units, char) => units + (char.codePointAt(0) < 128 ? 1 : 2), 0) <=
      4800,
  );
  assert.equal((await invoke(undefined, 'zzzzqqqxxxyyy')).output, '');
});

test('all generic profiles are selectable and the selector can only return a catalogued ID', async () => {
  const catalog = await import('n2-personas');
  for (const profile of catalog.listPersonas()) {
    const result = await invoke({ personaId: profile.id }, 'task');
    assert.equal(result.data.personaId, profile.id);
    assert.ok(result.output.length > 0);
  }
  const before = catalog.listPersonas();
  const chosen = await invoke(
    {
      version: 'custom-1',
      select: (_task, profiles) => {
        profiles[0].name = 'mutated';
        return 'dev/web-frontend';
      },
    },
    'task',
  );
  assert.equal(chosen.data.personaId, 'dev/web-frontend');
  assert.deepEqual(catalog.listPersonas(), before);
  await assert.rejects(
    invoke({ version: 'bad-1', select: () => '../../private' }, 'task'),
    /Unknown persona/,
  );
  assert.throws(() => expertiseTool({ personaId: '../../private' }), /Invalid persona ID/);
  assert.equal((await invoke(false, 'react')).data.selection, 'disabled');
});

test('uncooperative host selectors respect the outer tool deadline', async () => {
  const registry = new ToolRegistry([
    expertiseTool({ version: 'hang-1', select: () => new Promise(() => {}) }),
  ]);
  await assert.rejects(
    withDeadline(
      (signal) => registry.invoke('n2r_expertise', { task: 'task' }, { ...context(), signal }),
      20,
    ),
    /deadline/,
  );
});

test('normal host work receives additional generic expertise and cached retries retain its receipt', async () => {
  const runner = new RecipeRunner({
    dbPath: ':memory:',
    project: 'demo',
    agent: 'worker',
    tools: [
      {
        name: 'prepare',
        version: '1',
        readOnly: true,
        execute: () => ({ success: true, output: 'prepared' }),
      },
      {
        name: 'verify',
        version: '1',
        readOnly: true,
        execute: () => ({ success: true, output: 'verified' }),
      },
    ],
  });
  let calls = 0;
  const request = { runId: 'expertise', task: 'react css typescript frontend' },
    handler = {
      version: '1',
      execute: (ctx) => {
        calls++;
        assert.ok(ctx.context.systemAdditions.some((text) => text.includes('Web Frontend Expert')));
        return { success: true, output: 'done' };
      },
    };
  try {
    assert.equal((await runner.run(request, handler)).success, true);
    await runner.run(request, handler);
    assert.equal(calls, 1);
    const receipt = runner.status('expertise').calls.find((call) => call.tool === 'n2r_expertise');
    assert.equal(JSON.parse(receipt.result_json).data.personaId, 'dev/web-frontend');
  } finally {
    await runner.close();
  }
});
