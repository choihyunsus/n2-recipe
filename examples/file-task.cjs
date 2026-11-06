// The operator chooses the workspace. Repeated writes of the same task are idempotent.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

if (!process.env.N2R_DEMO_DIR) throw new Error('Set N2R_DEMO_DIR to an existing demo directory');
const root = fs.realpathSync(process.env.N2R_DEMO_DIR);
const output = path.join(root, 'answer.txt');

module.exports = {
  expertise: false,
  tools: [
    {
      name: 'prepare',
      version: '1',
      readOnly: true,
      execute: () => ({
        success: fs.statSync(root).isDirectory(),
        output: 'Demo directory checked',
      }),
    },
    {
      name: 'write_answer',
      version: '1',
      idempotent: true,
      execute: (args) => {
        if (typeof args.task !== 'string') throw new Error('Task text is required');
        fs.writeFileSync(output, args.task + '\n', 'utf8');
        return { success: true, output: 'answer.txt written', modifiedFiles: ['answer.txt'] };
      },
    },
    {
      name: 'verify',
      version: '1',
      readOnly: true,
      execute: (args) => {
        const bytes = fs.readFileSync(output);
        const success =
          args.files.includes('answer.txt') && bytes.toString('utf8') === args.task + '\n';
        return {
          success,
          output: success ? 'File content verified' : 'File content differs',
          data: { sha256: createHash('sha256').update(bytes).digest('hex') },
        };
      },
    },
  ],
  work: {
    version: '1',
    idempotent: true,
    execute: async (context) => {
      await context.callTool('write_answer', { task: context.context.prompt });
      return { success: true, output: 'Demo task finished' };
    },
  },
};
