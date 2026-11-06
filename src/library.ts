// Stable package entry point for host-controlled lifecycle execution.
export { RecipeRunner } from './runner';
export type { RunnerOptions } from './runner';
export { RecoveryRequired } from './run-types';
export type { RunRequest, RunReceipt, WorkHandler, WorkContext, PhaseReceipt } from './run-types';
export { parseRecipe } from './recipe-parser';
export {
  compileBundle,
  bundledRecipes,
  loadRecipeDirectory,
  validateRecipeUpdate,
} from './recipe-bundle';
export type { RecipeSources, RecipeBundle } from './recipe-bundle';
export { ToolRegistry } from './tool-registry';
export { inspectRun } from './inspect';
export type { CliAdapter } from './cli-adapter';
export type { ExpertiseOption, ExpertiseSelector, ExpertiseProfile } from './expertise';
export type {
  ToolDefinition,
  ToolContext,
  ToolResult,
  JsonValue,
  Phase,
  Recipe,
  RecipeStep,
  PhaseContext,
} from './types';
