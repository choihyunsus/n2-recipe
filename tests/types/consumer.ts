// Compile the public lifecycle API and stateful handlers without skipping dependency type checks.
import {
  RecipeRunner,
  ToolRegistry,
  type ToolDefinition,
  type WorkHandler,
  type WorkContext,
} from 'n2-recipe';

class Gate implements ToolDefinition {
  readonly version = '1';
  readonly readOnly = true;
  constructor(readonly name: string) {}
  execute() {
    return { success: true, output: this.name };
  }
}
class Work implements WorkHandler {
  readonly version = '1';
  execute(context: WorkContext) {
    return { success: true, output: context.context.prompt };
  }
}
const tools = [new Gate('prepare'), new Gate('verify')];
const registry = new ToolRegistry(tools);
const runner = new RecipeRunner({
  dbPath: ':memory:',
  project: 'consumer',
  agent: 'worker',
  tools,
});
const pending = runner.run({ runId: 'consumer-run', task: '한글 😀' }, new Work());
void [registry.list(), pending.then((result) => result.experienceId), runner.close()];
