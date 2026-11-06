const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { parseCli } = require('../dist/cli-args');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'n2r-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const run = (args) =>
    spawnSync(process.execPath, [path.resolve(__dirname, '../dist/index.js'), ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 2 * 1024 * 1024,
    });
  return { root, run };
}

test('CLI parses literal leading dashes and rejects ambiguous flags', () => {
  assert.equal(parseCli(['run', '--task=--help']).values.get('task'), '--help');
  assert.equal(parseCli(['run', '--task', '--help']).command, 'run');
  assert.throws(() => parseCli(['run', '--task', 'a', '--task', 'b']), /repeated/);
  assert.throws(() => parseCli(['status', '--adapter', 'x']), /Unknown/);
  assert.throws(() => parseCli(['run', '--task']), /incomplete/);
});

test('CLI validates bundled sources from another working directory and reports configuration errors', (t) => {
  const { run } = fixture(t);
  const valid = run(['validate']);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).phases.length, 4);
  assert.match(run(['--help']).stdout, /operator-selected adapter/);
  const missing = run(['run']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--db/);
  const absent = run([
    'status',
    '--db',
    'missing.db',
    '--project',
    'demo',
    '--agent',
    'worker',
    '--run-id',
    'absent',
  ]);
  assert.equal(absent.status, 1);
});

test('real ESM adapter runs file mutation and verification, cached replay and read-only status preserve the database', (t) => {
  const { root, run } = fixture(t),
    adapter = path.join(root, 'adapter.mjs'),
    filename = path.join(root, 'result.txt'),
    db = path.join(root, 'soul.db');
  fs.writeFileSync(
    adapter,
    `import fs from 'node:fs';
export default {expertise:false,tools:[
{name:'prepare',version:'1',readOnly:true,execute:()=>({success:true,output:'ready'})},
{name:'write',version:'1',execute:()=>{fs.appendFileSync(${JSON.stringify(filename)},'written\\n');return {success:true,output:'written',modifiedFiles:['result.txt']};}},
{name:'verify',version:'1',readOnly:true,execute:args=>({success:args.files[0]==='result.txt'&&fs.readFileSync(${JSON.stringify(filename)},'utf8')==='written\\n',output:'checked'})}
],work:{version:'1',execute:async ctx=>{await ctx.callTool('write');return {success:true,output:ctx.context.prompt};}}};`,
  );
  const scope = ['--db', db, '--project', 'demo', '--agent', 'worker', '--run-id', 'cli'];
  const args = ['run', ...scope, '--task=--help', '--adapter', adapter];
  const first = run(args);
  assert.equal(first.status, 0, first.stderr);
  const result = JSON.parse(first.stdout);
  assert.equal(result.work.output, '--help');
  assert.equal(result.success, true);
  const second = run(args);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), result);
  assert.equal(fs.readFileSync(filename, 'utf8'), 'written\n');
  const hash = () => createHash('sha256').update(fs.readFileSync(db)).digest('hex');
  const before = hash(),
    status = run(['status', ...scope]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).run.state, 'completed');
  assert.equal(hash(), before);
  assert.deepEqual(
    JSON.parse(
      run(['status', '--db', db, '--project', 'other', '--agent', 'worker', '--run-id', 'cli'])
        .stdout,
    ),
    { found: false },
  );
});

test('CJS adapter with failed verification returns a failure receipt and process exit code 2', (t) => {
  const { root, run } = fixture(t),
    adapter = path.join(root, 'adapter.cjs');
  fs.writeFileSync(
    adapter,
    `module.exports={tools:[{name:'prepare',version:'1',execute:()=>({success:true,output:'ready'})},{name:'verify',version:'1',execute:()=>({success:false,output:'test failed'})}],work:{version:'1',execute:()=>({success:true,output:'done'})}};`,
  );
  const result = run([
    'run',
    '--db',
    path.join(root, 'failed.db'),
    '--project',
    'demo',
    '--agent',
    'worker',
    '--run-id',
    'failed',
    '--task',
    'task',
    '--adapter',
    adapter,
  ]);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).success, false);
});
