const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createContext,
  resolveArguments,
  evaluateCondition,
  applyInjection,
  supportedCode,
} = require('../dist/context');

test('one-pass substitution keeps inserted templates and commas as literal data', () => {
  const context = createContext('literal ${secret},server=other');
  context.variables.secret = 'private fixture';
  const resolved = resolveArguments(
    { task: '${prompt}', direct: '${secret}', unknown: '${missing}' },
    context,
  );
  assert.equal(resolved.task, context.prompt);
  assert.equal(resolved.direct, 'private fixture');
  assert.equal(resolved.unknown, '${missing}');
  assert.equal(Object.hasOwn(resolved, 'server'), false);
});

test('file arrays preserve comma-containing paths while legacy string placeholders retain compatibility', () => {
  const context = createContext('fixture', ['source,a.MJS', 'notes.md', 'types.pyi']);
  assert.equal(evaluateCondition('if ${has_code_changes}', context), true);
  assert.deepEqual(
    resolveArguments(
      { files: '${modified_code_files_array}', all: '${modified_files_array}' },
      context,
    ),
    { files: ['source,a.MJS', 'types.pyi'], all: context.modifiedFiles },
  );
  assert.equal(resolveArguments('${modified_files}', context), context.modifiedFiles.join(','));
  assert.equal(supportedCode('file.hpp'), false);
  assert.equal(
    evaluateCondition('if ${has_code_changes}', createContext('docs', ['notes.md'])),
    false,
  );
});

test('failure conditions retain diagnostics after recovery and unknown expressions fail explicitly', () => {
  const context = createContext('fixture');
  context.lastFailure = 'verification failed';
  context.lastStepFailed = true;
  assert.equal(evaluateCondition('if ${last_step_failed}', context), true);
  context.lastStepFailed = false;
  assert.equal(evaluateCondition('if ${last_step_failed}', context), false);
  assert.equal(resolveArguments('${last_failure}', context), 'verification failed');
  context.variables.flag = 'false';
  assert.equal(evaluateCondition('if ${flag}', context), false);
  assert.throws(() => evaluateCondition('if ${flag} || true', context), /Unsupported/);
});

test('injection is UTF-8 bounded and aggregate arguments cannot expand without a limit', () => {
  const context = createContext('fixture');
  applyInjection('system_prompt', '한글😀'.repeat(2000), context);
  assert.ok(Buffer.byteLength(context.systemAdditions[0]) <= 8192);
  assert.equal(context.systemAdditions[0].includes('\uFFFD'), false);
  applyInjection('__proto__', 'literal value', context);
  assert.equal(context.variables.__proto__, 'literal value');
  context.prompt = 'x'.repeat(8000);
  assert.throws(() => resolveArguments(Array(10).fill('${prompt}'), context), /byte limit/);
});

test('a failed aggregate injection preserves the preceding context', () => {
  const context = createContext('fixture');
  let bounded = false;
  for (let index = 0; index < 40; index++) {
    const before = JSON.stringify(context);
    try {
      applyInjection('system_prompt', 'x'.repeat(8192), context);
    } catch (error) {
      assert.match(error.message, /byte limit/);
      assert.equal(JSON.stringify(context), before);
      bounded = true;
      break;
    }
  }
  assert.equal(bounded, true);
});
