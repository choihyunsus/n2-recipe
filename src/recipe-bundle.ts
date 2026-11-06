// Validate complete strict lifecycle bundles and protect configured checks during recipe edits.
import fs from 'node:fs';
import path from 'node:path';
import { PHASES, type Phase, type Recipe } from './types';
import { parseRecipe } from './recipe-parser';
import { fingerprint } from './fingerprint';

export type RecipeSources = Record<Phase, string>;
export interface RecipeBundle {
  sources: RecipeSources;
  recipes: Record<Phase, Recipe>;
  hash: string;
}

export function compileBundle(sources: RecipeSources): RecipeBundle {
  if (!sources || typeof sources !== 'object' || Object.keys(sources).length !== PHASES.length)
    throw new Error('A bundle must supply all four lifecycle phases');
  const recipes = {} as Record<Phase, Recipe>;
  for (const phase of PHASES) {
    const recipe = parseRecipe(sources[phase]);
    if (recipe.phase !== phase || recipe.name !== phase)
      throw new Error('Recipe name and phase must match its bundle key');
    if (!recipe.enforce) throw new Error('Lifecycle execution requires strict recipes');
    if (!recipe.steps.some((step) => step.required && step.condition === null))
      throw new Error(`Phase ${phase} requires an unconditional required check`);
    recipes[phase] = recipe;
  }
  const hashes = PHASES.map((phase) => {
    const { sourceHash, ...semantic } = recipes[phase];
    void sourceHash;
    return fingerprint(semantic, 128 * 1024);
  });
  return { sources: { ...sources }, recipes, hash: fingerprint(hashes) };
}

export function bundledRecipes(): RecipeSources {
  return loadRecipeDirectory(path.resolve(__dirname, '../recipes'));
}

export function loadRecipeDirectory(directory: string): RecipeSources {
  const root = fs.realpathSync(directory),
    entries = fs.opendirSync(root);
  const sources = {} as RecipeSources;
  let count = 0;
  try {
    for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
      if (++count > 1024) throw new Error('Recipe directory exceeds 1,024 entries');
      if (!entry.name.toLowerCase().endsWith('.n2r')) continue;
      const phase = entry.name.slice(0, -4) as Phase;
      if (!PHASES.includes(phase) || entry.name !== `${phase}.n2r` || Object.hasOwn(sources, phase))
        throw new Error('Recipe directory contains an unknown or duplicate lifecycle filename');
      sources[phase] = readRecipeFile(root, path.join(root, entry.name));
    }
  } finally {
    entries.closeSync();
  }
  compileBundle(sources);
  return sources;
}

export function validateRecipeUpdate(baseline: RecipeBundle, phase: Phase, source: string): Recipe {
  if (phase !== 'work_start' && phase !== 'work_end')
    throw new Error('Only work_start and work_end recipes can be edited');
  const candidate = compileBundle({ ...baseline.sources, [phase]: source }).recipes[phase];
  const protectedSteps = baseline.recipes[phase].steps;
  const actual = candidate.steps.filter((step) =>
    protectedSteps.some((original) => original.name === step.name),
  );
  if (
    actual.length !== protectedSteps.length ||
    actual.some((step, index) => fingerprint(step) !== fingerprint(protectedSteps[index]))
  )
    throw new Error('Configured lifecycle checks must retain their definitions and relative order');
  return candidate;
}

function readRecipeFile(root: string, filename: string): string {
  const resolved = fs.realpathSync(filename),
    relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw new Error('Recipe resolves outside its directory');
  const descriptor = fs.openSync(resolved, 'r');
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size > 65536)
      throw new Error('Recipe must be a regular file within 64 KiB');
    const bytes = Buffer.alloc(65537);
    let size = 0;
    while (size < bytes.length) {
      const read = fs.readSync(descriptor, bytes, size, bytes.length - size, null);
      if (!read) break;
      size += read;
    }
    const after = fs.fstatSync(descriptor);
    if (
      size > 65536 ||
      size !== after.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      fs.realpathSync(filename) !== resolved
    )
      throw new Error('Recipe changed while being read or exceeded its size limit');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
  } finally {
    fs.closeSync(descriptor);
  }
}
