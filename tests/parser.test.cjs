// The real published Clotho WASM parser remains the only grammar implementation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseRecipe } = require('../dist/recipe-parser');
const { jsonValue } = require('../dist/values');

function recipe(steps, settings = 'enforce: strict') {
  return `@meta { name: "work_start" version: "1.0.0" phase: "work_start" }
  @recipe WorkStart { ${settings} ${steps} }`;
}

test('typed arguments preserve strings, booleans, nested arrays and literal template data', () => {
  const input = {
    count: 2,
    enabled: true,
    data: ['한글', null, { text: '${prompt}' }],
    quoted: 'say "hello"',
  };
  const parsed = parseRecipe(
    recipe(
      `step prepare { tool: "prepare" args_json: ${JSON.stringify(JSON.stringify(input))} required: true inject: "system_prompt" }`,
    ),
  );
  assert.equal(parsed.phase, 'work_start');
  assert.equal(parsed.enforce, true);
  assert.deepEqual(parsed.steps[0].args, input);
  assert.deepEqual(parsed.steps[0].onFail, { action: 'abort' });
  assert.match(parsed.sourceHash, /^[a-f0-9]{64}$/);
});

test('legacy KV values keep their original types and first-key-wins boundary', () => {
  const parsed = parseRecipe(
    recipe(
      'step route { action: "route" args: "server=fixture,count=15,verbose=true,task=${prompt},server=other" }',
    ),
  );
  assert.deepEqual(parsed.steps[0].args, {
    server: 'fixture',
    count: 15,
    verbose: true,
    task: '${prompt}',
  });
  const array = parseRecipe(recipe('step data { tool: "data" args: [1, true, "literal"] }'));
  assert.deepEqual(array.steps[0].args, [1, true, 'literal']);
  const large = parseRecipe(recipe('step data { tool: "data" args: "id=9007199254740993" }'));
  assert.equal(large.steps[0].args.id, '9007199254740993');
});

test('ambiguous fields, unsupported conditions and invalid jump targets are rejected', () => {
  for (const body of [
    'tool: "a" action: "b"',
    'tool: "a" args: "" args_json: "{}"',
    'tool: "a" required: maybe',
    'tool: "a" unknown: true',
    'tool: "a" condition: "if ${x} or true"',
    'tool: "a" on_fail: "ignore"',
    'tool: "a" on_fail: "goto missing"',
    'required: true',
    'tool: "a" args_json: "[]"',
  ])
    assert.throws(() => parseRecipe(recipe(`step first { ${body} }`)));
  assert.throws(
    () => parseRecipe(recipe('step same { tool: "a" } step same { tool: "b" }')),
    /Duplicate/,
  );
  assert.throws(() => parseRecipe(recipe('', 'unknown: true')), /enforce/);
  assert.throws(() => parseRecipe('@meta {name:"x" phase:"unknown"} @recipe X {}'), /phase/);
  assert.throws(() => parseRecipe(recipe('') + '@recipe Extra {}'), /exactly one/);
});

test('strict parsing bounds input size, nesting, unsafe numbers and prototype-shaped data', () => {
  const steps = Array.from({ length: 64 }, (_, index) => `step s${index} { tool: "fixture" }`).join(
    '\n',
  );
  assert.equal(parseRecipe(recipe(steps)).steps.length, 64);
  assert.throws(() => parseRecipe(recipe(steps + ' step extra { tool: "fixture" }')), /64 steps/);
  assert.throws(() => parseRecipe(' '.repeat(65537)), /source/);
  assert.throws(() => parseRecipe('broken syntax'), /Recipe parse failed/);
  assert.throws(() => jsonValue(9007199254740992), /precision/);
  assert.throws(() => jsonValue(Array(5000).fill(0)), /element/);
  assert.throws(() => jsonValue(Array(100).fill('x'.repeat(1000))), /byte/);
  let deep = 0;
  for (let index = 0; index < 18; index++) deep = [deep];
  assert.throws(() => jsonValue(deep), /nesting/);
  const shaped = jsonValue(JSON.parse('{"__proto__":{"fixture":true},"constructor":"literal"}'));
  assert.equal(Object.hasOwn(shaped, '__proto__'), true);
  assert.equal({}.fixture, undefined);
});
