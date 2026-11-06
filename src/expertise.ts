// Adapt Daebung's metadata BM25 and trigger scoring to the independently published persona catalog.
import { boundedText } from './values';
import type { JsonValue, ToolDefinition } from './types';

export interface ExpertiseProfile {
  id: string;
  category: string;
  name: string;
  tags: string[];
}
export interface ExpertiseSelector {
  version: string;
  select(
    task: string,
    profiles: readonly ExpertiseProfile[],
    signal: AbortSignal,
  ): string | null | Promise<string | null>;
}
export type ExpertiseOption = false | { personaId: string } | ExpertiseSelector;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const TRIGGER_WEIGHT = 3;

export function expertiseTool(option?: ExpertiseOption): ToolDefinition {
  const configured = checkedOption(option);
  const version =
    configured === false
      ? 'disabled'
      : configured && 'personaId' in configured
        ? `fixed-${configured.personaId}`
        : (configured?.version ?? 'catalog-bm25-1');
  return {
    name: 'n2r_expertise',
    version: `personas-1.0.0/${version}`,
    readOnly: true,
    execute: async (args, context) => {
      if (configured === false)
        return { success: true, output: '', data: { personaId: null, selection: 'disabled' } };
      const task = taskArgument(args),
        catalog = await import('n2-personas');
      const profiles = catalog.listPersonas();
      const selected =
        configured && 'personaId' in configured
          ? configured.personaId
          : configured
            ? await configured.select(task, profiles, context.signal)
            : (matchExpertise(task, profiles)?.id ?? null);
      context.signal.throwIfAborted();
      if (selected === null)
        return { success: true, output: '', data: { personaId: null, selection: 'unmatched' } };
      const profile = catalog.getPersona(boundedText(selected, 'selected persona ID', 96));
      return {
        success: true,
        output: boundGuidance(
          `# Task Expertise: ${profile.name}\nApply this domain guidance alongside the configured identity, project memory, user instructions and host policy.\n${profile.prompt}`,
        ),
        data: { personaId: profile.id, selection: configured ? 'configured' : 'catalog-bm25' },
      };
    },
  };
}

export function matchExpertise(
  task: string,
  profiles: readonly ExpertiseProfile[],
): ExpertiseProfile | undefined {
  const terms = [...new Set(tokenize(task))];
  if (!terms.length || !profiles.length) return undefined;
  const documents = profiles.map((profile) =>
    tokenize(`${profile.id} ${profile.category} ${profile.name} ${profile.tags.join(' ')}`),
  );
  const average = documents.reduce((sum, tokens) => sum + tokens.length, 0) / documents.length;
  const counts = new Map<string, number>();
  for (const tokens of documents)
    for (const term of new Set(tokens)) counts.set(term, (counts.get(term) ?? 0) + 1);
  const scored = profiles.map((profile, index) => ({
    profile,
    score: profileScore(terms, profile, documents[index]!, counts, profiles.length, average),
  }));
  scored.sort(
    (left, right) => right.score - left.score || (left.profile.id < right.profile.id ? -1 : 1),
  );
  return scored[0]!.score > 0 ? scored[0]!.profile : undefined;
}

function profileScore(
  terms: string[],
  profile: ExpertiseProfile,
  document: string[],
  counts: Map<string, number>,
  total: number,
  average: number,
): number {
  const tags = new Set(profile.tags.flatMap(tokenize));
  let score = 0;
  for (const term of terms) {
    const frequency = document.filter((token) => token === term).length;
    if (!frequency) continue;
    const present = counts.get(term)!;
    const idf = Math.log((total - present + 0.5) / (present + 0.5) + 1);
    score +=
      (idf * frequency * (BM25_K1 + 1)) /
      (frequency + BM25_K1 * (1 - BM25_B + (BM25_B * document.length) / Math.max(1, average)));
    if (tags.has(term)) score += TRIGGER_WEIGHT;
  }
  return score;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 1);
}

function checkedOption(option?: ExpertiseOption): ExpertiseOption | undefined {
  if (option === undefined || option === false) return option;
  if (!option || typeof option !== 'object') throw new Error('Invalid expertise configuration');
  if ('personaId' in option) {
    const id = boundedText(option.personaId, 'persona ID', 96);
    if (!/^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('Invalid persona ID');
    return { personaId: id };
  }
  if (
    !boundedText(option.version, 'expertise selector version', 64).trim() ||
    typeof option.select !== 'function'
  )
    throw new Error('Expertise selectors require a version and select callback');
  return { ...option };
}

function taskArgument(args: JsonValue): string {
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new Error('Expertise arguments require a task');
  return boundedText(args.task, 'expertise task');
}

function boundGuidance(value: string): string {
  let result = '',
    units = 0,
    bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if ((point < 32 && character !== '\n' && character !== '\t') || (point >= 127 && point <= 159))
      continue;
    const cost = point < 128 ? 1 : 2,
      size = Buffer.byteLength(character);
    if (units + cost > 4800 || bytes + size > 8192) break;
    units += cost;
    bytes += size;
    result += character;
  }
  return result;
}
