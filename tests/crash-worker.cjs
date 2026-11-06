// Deliberately remain inside an externally observable write until the test terminates this process.
const fs = require('node:fs');
const { RecipeRunner } = require('../dist/library');
const runner = new RecipeRunner({
  dbPath: process.argv[2],
  project: 'demo',
  agent: 'worker',
  tools: [
    { name: 'prepare', version: '1', execute: () => ({ success: true, output: 'ready' }) },
    { name: 'verify', version: '1', execute: () => ({ success: true, output: 'verified' }) },
  ],
});
runner
  .run(
    { runId: 'crashed', task: 'task' },
    {
      version: '1',
      execute: () => {
        fs.appendFileSync(process.argv[3], 'written\n');
        process.send({ ready: true });
        return new Promise(() => {});
      },
    },
  )
  .catch((error) => {
    process.stderr.write(error.stack);
    process.exitCode = 1;
  });
