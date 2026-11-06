const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  compileBundle,
  bundledRecipes,
  loadRecipeDirectory,
  validateRecipeUpdate,
} = require('../dist/recipe-bundle');

test('bundled lifecycle checks require a complete strict four-phase configuration', () => {
  const sources = bundledRecipes(),
    bundle = compileBundle(sources);
  assert.deepEqual(Object.keys(bundle.recipes), ['boot', 'work_start', 'work_end', 'end']);
  assert.equal(bundle.recipes.work_end.steps[0].tool, 'verify');
  assert.throws(() => compileBundle({ ...sources, end: undefined }));
  assert.throws(
    () => compileBundle({ ...sources, work_start: sources.work_start.replace('strict', 'warn') }),
    /strict/,
  );
  assert.throws(
    () =>
      compileBundle({
        ...sources,
        work_start:
          '@meta {name:"work_start" phase:"work_start"} @recipe WorkStart {enforce:strict}',
      }),
    /required check/,
  );
  const spacing = { ...sources, work_start: sources.work_start + '\n# comment only\n' };
  assert.equal(compileBundle(spacing).hash, bundle.hash);
});

test('work recipe edits keep configured checks while boot and end remain fixed', () => {
  const sources = bundledRecipes(),
    bundle = compileBundle(sources);
  const extended = sources.work_end.replace(/\}\s*$/, 'step diagnostic { tool:"diagnostic" }\n}');
  assert.equal(validateRecipeUpdate(bundle, 'work_end', extended).steps.length, 2);
  assert.throws(() => validateRecipeUpdate(bundle, 'boot', sources.boot), /Only work_start/);
  assert.throws(
    () =>
      validateRecipeUpdate(
        bundle,
        'work_end',
        sources.work_end.replace('required: true', 'required: false'),
      ),
    /required check|definitions/,
  );
  assert.throws(
    () =>
      validateRecipeUpdate(
        bundle,
        'work_end',
        sources.work_end.replace('tool: "verify"', 'tool: "other"'),
      ),
    /definitions/,
  );
});

test('directory loading rejects aliases, malformed UTF-8 and escaped source paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'n2r-recipes-'));
  const directory = path.join(root, 'recipes');
  fs.mkdirSync(directory);
  try {
    const sources = bundledRecipes();
    for (const [phase, source] of Object.entries(sources))
      fs.writeFileSync(path.join(directory, phase + '.n2r'), source);
    assert.deepEqual(loadRecipeDirectory(directory), sources);
    fs.writeFileSync(path.join(directory, 'extra.n2r'), sources.boot);
    assert.throws(() => loadRecipeDirectory(directory), /unknown or duplicate/);
    fs.unlinkSync(path.join(directory, 'extra.n2r'));
    fs.writeFileSync(path.join(directory, 'boot.n2r'), Buffer.from([255, 254]));
    assert.throws(() => loadRecipeDirectory(directory), /encoded data/i);
    fs.unlinkSync(path.join(directory, 'boot.n2r'));
    fs.writeFileSync(path.join(root, 'outside.n2r'), sources.boot);
    try {
      fs.symlinkSync(path.join(root, 'outside.n2r'), path.join(directory, 'boot.n2r'), 'file');
      assert.throws(() => loadRecipeDirectory(directory), /outside/);
    } catch (error) {
      if (error.code !== 'EPERM') throw error;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
