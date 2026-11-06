const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RecipeRunner, bundledRecipes, RecoveryRequired } = require('../dist/library');
const { MimirDatabase } = require('n2-mimir/storage');
const { fork } = require('node:child_process');
const { once } = require('node:events');

const ok = (output = 'ok', modifiedFiles) => ({
  success: true,
  output,
  ...(modifiedFiles ? { modifiedFiles } : {}),
});
const tool = (name, execute, options = {}) => ({ name, version: '1', execute, ...options });
const work = (execute) => ({ version: '1', execute });
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'n2r-run-'));
  const options = {
    dbPath: path.join(root, 'soul.db'),
    project: 'demo',
    agent: 'worker',
    tools: [
      tool('prepare', () => ok(), { readOnly: true }),
      tool('verify', () => ok(), { readOnly: true }),
    ],
    ...overrides,
  };
  const runners = [];
  const open = (changes = {}) => {
    const runner = new RecipeRunner({ ...options, ...changes });
    runners.push(runner);
    return runner;
  };
  t.after(async () => {
    for (const runner of runners) await runner.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { root, options, open };
}

test('normal entry performs all phases, free work calls, post verification and exactly one scoped experience across restart', async (t) => {
  const order = [],
    f = fixture(t);
  const filename = path.join(f.root, 'comma,file.ts');
  const tools = [
    tool(
      'prepare',
      () => {
        order.push('prepare');
        return ok();
      },
      { readOnly: true },
    ),
    tool('write', () => {
      order.push('write');
      fs.writeFileSync(filename, 'export const value = 7;');
      return ok('written', ['comma,file.ts']);
    }),
    tool(
      'verify',
      (args) => {
        order.push('verify');
        assert.deepEqual(args.files, ['comma,file.ts']);
        assert.match(fs.readFileSync(filename, 'utf8'), /value = 7/);
        return ok('verified');
      },
      { readOnly: true },
    ),
  ];
  const memory = new MimirDatabase(f.options.dbPath);
  const foreign = memory.insertExperience({
    agent: 'other',
    project: 'demo',
    type: 'success',
    category: 'test',
    context: 'private-other-owner',
    action: 'a',
    outcome: 'b',
  });
  memory.close();
  let runner = f.open({ tools });
  const request = { runId: 'one', sessionId: 'session', task: 'write a value' };
  const handler = work(async (ctx) => {
    assert.ok(!JSON.stringify(ctx.context).includes('private-other-owner'));
    await ctx.callTool('write');
    return ok('done');
  });
  const result = await runner.run(request, handler);
  assert.equal(result.success, true);
  assert.deepEqual(
    result.phases.map((phase) => phase.phase),
    ['boot', 'work_start', 'work_end', 'end'],
  );
  assert.deepEqual(order, ['prepare', 'write', 'verify']);
  assert.equal(runner.status('one').calls.length, 7);
  assert.deepEqual(
    runner.status('one').calls.map((call) => call.phase),
    ['boot', 'work_start', 'work_start', 'work', 'work', 'work_end', 'end'],
  );
  await runner.close();
  runner = f.open({ tools });
  assert.deepEqual(await runner.run(request, handler), result);
  assert.deepEqual(order, ['prepare', 'write', 'verify']);
  const after = new MimirDatabase(f.options.dbPath);
  try {
    const rows = after.queryExperiences({ project: 'demo', agent: 'worker' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, result.experienceId);
    assert.equal(rows[0].sessionId, 'session');
    assert.equal(rows[0].type, 'success');
    assert.equal(after.getExperience(foreign.id).context, 'private-other-owner');
    assert.deepEqual(after.reasoning.connection.query('PRAGMA foreign_key_check'), []);
    assert.equal(
      after.reasoning.connection.query('PRAGMA integrity_check')[0].integrity_check,
      'ok',
    );
  } finally {
    after.close();
  }
});

test('failed preparation prevents work and post checks while end records the failure', async (t) => {
  let worked = 0,
    verified = 0;
  const f = fixture(t, {
    tools: [
      tool('prepare', () => ({ success: false, output: 'prerequisite missing' })),
      tool('verify', () => {
        verified++;
        return ok();
      }),
    ],
  });
  const runner = f.open(),
    request = { runId: 'blocked', task: 'blocked task' };
  const handler = work(() => {
    worked++;
    return ok();
  });
  const receipt = await runner.run(request, handler);
  assert.equal(receipt.success, false);
  assert.equal(worked, 0);
  assert.equal(verified, 0);
  assert.deepEqual(
    receipt.phases.map((p) => p.phase),
    ['boot', 'work_start', 'end'],
  );
  assert.deepEqual(receipt.phases[1].failedRequired, ['prepare']);
  assert.deepEqual(await runner.run(request, handler), receipt);
});

test('negative work and post results cannot become success even when final checkpoint passes', async (t) => {
  const f = fixture(t);
  const failedWork = await f.open().run(
    { runId: 'failed-work', task: 'task' },
    work(() => ({ success: false, output: 'work failed' })),
  );
  assert.equal(failedWork.success, false);
  assert.equal(failedWork.phases.find((p) => p.phase === 'work_end').success, true);
  const failedPost = await f
    .open({
      agent: 'post-worker',
      tools: [
        tool('prepare', () => ok()),
        tool('verify', () => ({ success: false, output: 'test failed' })),
      ],
    })
    .run(
      { runId: 'failed-post', task: 'task' },
      work(() => ok()),
    );
  assert.equal(failedPost.success, false);
  assert.equal(failedPost.phases.at(-1).success, true);
});

test('required failure survives a successful recovery and goto cannot bypass an unvisited required check', async (t) => {
  const recipes = bundledRecipes();
  recipes.work_start =
    '@meta {name:"work_start" phase:"work_start"} @recipe WorkStart {enforce:strict step first {tool:"prepare" required:true on_fail:"goto recovery"} step skipped {tool:"verify" required:true} step recovery {tool:"recover"}}';
  const runner = fixture(t, {
    recipes,
    tools: [
      tool('prepare', () => ({ success: false, output: 'broken' })),
      tool('verify', () => ok()),
      tool('recover', () => ok('diagnosed')),
    ],
  }).open();
  const result = await runner.run(
    { runId: 'goto', task: 'task' },
    work(() => {
      throw new Error('work must not execute');
    }),
  );
  assert.equal(result.success, false);
  assert.deepEqual(result.phases[1].failedRequired, ['first']);
  assert.deepEqual(result.phases[1].missedRequired, ['skipped']);
});

test('a reached conditional required check may be inapplicable and bounded loops produce an explicit failure', async (t) => {
  const recipes = bundledRecipes();
  recipes.work_start =
    '@meta {name:"work_start" phase:"work_start"} @recipe WorkStart {enforce:strict step first {tool:"prepare" required:true} step conditional {tool:"verify" required:true condition:"if ${has_code_changes}"}}';
  const f = fixture(t, { recipes }),
    runner = f.open();
  assert.equal(
    (
      await runner.run(
        { runId: 'conditional', task: 'task' },
        work(() => ok()),
      )
    ).success,
    true,
  );
  recipes.work_start =
    '@meta {name:"work_start" phase:"work_start"} @recipe WorkStart {enforce:strict step repeat {tool:"prepare" required:true on_fail:"goto repeat"}}';
  const loop = f.open({
    agent: 'loop',
    recipes,
    tools: [
      tool('prepare', () => ({ success: false, output: 'retry' })),
      tool('verify', () => ok()),
    ],
  });
  const result = await loop.run(
    { runId: 'loop', task: 'task' },
    work(() => ok()),
  );
  assert.equal(result.success, false);
  assert.equal(result.phases[1].calls, 3);
  assert.match(result.phases[1].output, /iteration limit/);
});

test('unfinished non-idempotent work requires explicit reconciliation and then still runs post verification', async (t) => {
  let executions = 0,
    verification = 0;
  const f = fixture(t, {
      tools: [
        tool('prepare', () => ok()),
        tool('verify', () => {
          verification++;
          return ok();
        }),
      ],
    }),
    runner = f.open();
  const request = { runId: 'uncertain', task: 'task' },
    handler = work(() => {
      executions++;
      throw new Error('connection ended after mutation');
    });
  await assert.rejects(runner.run(request, handler), /after mutation/);
  assert.equal(runner.status('uncertain').run.state, 'interrupted');
  await assert.rejects(runner.run(request, handler), RecoveryRequired);
  assert.equal(executions, 1);
  assert.equal(verification, 0);
  runner.reconcileCall(
    'uncertain',
    'work:0',
    ok('checked on disk', ['written.ts']),
    'Inspected the written file and confirmed the operation completed',
  );
  const receipt = await runner.run(request, handler);
  assert.equal(receipt.success, true);
  assert.equal(executions, 1);
  assert.equal(verification, 1);
  assert.deepEqual(receipt.work.modifiedFiles, ['written.ts']);
});

test('idempotent replay reuses completed child calls, rejects changed arguments and preserves stable call IDs', async (t) => {
  const ids = [];
  let callbackRuns = 0,
    childRuns = 0,
    argument = 'original';
  const f = fixture(t, {
    tools: [
      tool('prepare', () => ok()),
      tool('verify', () => ok()),
      tool('write', (_args, ctx) => {
        childRuns++;
        ids.push(ctx.callId);
        return ok('saved', ['a.ts']);
      }),
    ],
  });
  const runner = f.open(),
    request = { runId: 'replay', task: 'task' };
  const handler = {
    version: '1',
    idempotent: true,
    execute: async (ctx) => {
      callbackRuns++;
      await ctx.callTool('write', { value: argument });
      if (callbackRuns === 1) throw new Error('interrupt after child');
      return ok();
    },
  };
  await assert.rejects(runner.run(request, handler), /interrupt after child/);
  argument = 'changed';
  await assert.rejects(runner.run(request, handler), /Replay diverged/);
  argument = 'original';
  const receipt = await runner.run(request, handler);
  assert.equal(receipt.success, true);
  assert.equal(childRuns, 1);
  assert.deepEqual(ids, ['work:1']);
  assert.deepEqual(receipt.work.modifiedFiles, ['a.ts']);
});

test('child uncertainty blocks replay and root reconciliation until child evidence is resolved', async (t) => {
  let childRuns = 0,
    verifiedFiles;
  const f = fixture(t, {
    tools: [
      tool('prepare', () => ok()),
      tool('verify', (args) => {
        verifiedFiles = args.files;
        return ok();
      }),
      tool('write', () => {
        childRuns++;
        throw new Error('unknown write');
      }),
    ],
  });
  const runner = f.open(),
    request = { runId: 'child', task: 'task' };
  const handler = {
    version: '1',
    idempotent: true,
    execute: async (ctx) => {
      await ctx.callTool('write');
      return ok();
    },
  };
  await assert.rejects(runner.run(request, handler), /unknown write/);
  await assert.rejects(runner.run(request, handler), RecoveryRequired);
  assert.throws(
    () => runner.reconcileCall('child', 'work:0', ok(), 'checked'),
    /pending work tool/,
  );
  runner.reconcileCall('child', 'work:1', ok('written', ['child.ts']), 'Inspected child.ts');
  runner.reconcileCall('child', 'work:0', ok(), 'Inspected final work outcome');
  const receipt = await runner.run(request, handler);
  assert.equal(receipt.success, true);
  assert.equal(childRuns, 1);
  assert.deepEqual(verifiedFiles, ['child.ts']);
});

test('uncooperative deadlines leave pending work, close settles and late callbacks cannot append tool calls', async (t) => {
  let captured;
  const f = fixture(t, { deadlines: { workMs: 30 } }),
    runner = f.open();
  const request = { runId: 'timeout', task: 'task' };
  const pending = runner.run(
    request,
    work((ctx) => {
      captured = ctx;
      return new Promise(() => {});
    }),
  );
  await assert.rejects(pending, /deadline/);
  assert.equal(runner.status('timeout').calls.find((c) => c.call_id === 'work:0').state, 'pending');
  assert.throws(() => captured.callTool('prepare'), /no longer active/);
  await runner.close();
  assert.throws(() => runner.status('timeout'), /closed/);
});

test('duplicate owners are fenced while different agent scopes retain isolated runs', async (t) => {
  let entered, release;
  const start = new Promise((resolve) => {
      entered = resolve;
    }),
    gate = new Promise((resolve) => {
      release = resolve;
    });
  const f = fixture(t),
    first = f.open(),
    second = f.open();
  const running = first.run(
    { runId: 'same', task: 'task' },
    work(async () => {
      entered();
      await gate;
      return ok();
    }),
  );
  await start;
  await assert.rejects(
    second.run(
      { runId: 'different', task: 'task' },
      work(() => ok()),
    ),
    /active N2R operation/,
  );
  const other = f.open({ agent: 'other' });
  assert.equal(
    (
      await other.run(
        { runId: 'same', task: 'another owner' },
        work(() => ok()),
      )
    ).success,
    true,
  );
  release();
  assert.equal((await running).success, true);
  assert.equal(second.status('same').run.state, 'completed');
});

test('recipe revisions activate on new runs while an interrupted run retains its original checks', async (t) => {
  let extra = 0,
    executions = 0;
  const f = fixture(t, {
      tools: [
        tool('prepare', () => ok()),
        tool('verify', () => ok()),
        tool('extra', () => {
          extra++;
          return ok();
        }),
      ],
    }),
    runner = f.open();
  const request = { runId: 'old', task: 'task' },
    handler = {
      version: '1',
      idempotent: true,
      execute: () => {
        if (++executions === 1) throw new Error('pause');
        return ok();
      },
    };
  await assert.rejects(runner.run(request, handler), /pause/);
  const original = runner.recipes();
  const updated = original.sources.work_end.replace(
    /\}\s*$/,
    'step added {tool:"extra" required:true}\n}',
  );
  assert.equal(runner.updateRecipe('work_end', updated, original.hash), 2);
  assert.throws(() => runner.updateRecipe('work_end', updated, original.hash), /changed/);
  assert.equal((await runner.run(request, handler)).success, true);
  assert.equal(extra, 0);
  assert.equal((await runner.run({ runId: 'new', task: 'task' }, handler)).success, true);
  assert.equal(extra, 1);
});

test('input or handler version mismatch cannot return another cached outcome', async (t) => {
  const runner = fixture(t).open(),
    handler = work(() => ok()),
    request = { runId: 'identity', task: 'task' };
  await runner.run(request, handler);
  await assert.rejects(runner.run({ ...request, task: 'different' }, handler), /different input/);
  await assert.rejects(runner.run(request, { ...handler, version: '2' }), /different input/);
  assert.equal(runner.status('identity').run.state, 'completed');
});

test('actual killed process retains uncertain side effects and a dead-PID lease can be recovered', async (t) => {
  const f = fixture(t, { tools: [tool('prepare', () => ok()), tool('verify', () => ok())] });
  const filename = path.join(f.root, 'effect.txt');
  const child = fork(path.join(__dirname, 'crash-worker.cjs'), [f.options.dbPath, filename], {
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Child did not enter its write callback')),
      5000,
    );
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('message', (message) => {
      clearTimeout(timer);
      message.ready ? resolve() : reject(new Error('Unexpected child event'));
    });
  });
  const exited = once(child, 'exit');
  child.kill();
  await exited;
  assert.equal(fs.readFileSync(filename, 'utf8'), 'written\n');
  const runner = f.open();
  let repeats = 0;
  const handler = work(() => {
    repeats++;
    fs.appendFileSync(filename, 'repeated\n');
    return ok();
  });
  const request = { runId: 'crashed', task: 'task' };
  await assert.rejects(runner.run(request, handler), RecoveryRequired);
  assert.equal(repeats, 0);
  runner.reconcileCall(
    'crashed',
    'work:0',
    ok('write survived', ['effect.txt']),
    'Inspected effect.txt after child process termination',
  );
  assert.equal((await runner.run(request, handler)).success, true);
  assert.equal(repeats, 0);
  assert.equal(fs.readFileSync(filename, 'utf8'), 'written\n');
});

test('expired lease ownership prevents a late result from committing into a replacement run', async (t) => {
  const f = fixture(t),
    first = f.open(),
    second = f.open();
  let entered, release;
  const start = new Promise((resolve) => {
      entered = resolve;
    }),
    gate = new Promise((resolve) => {
      release = resolve;
    });
  const pending = first.run(
    { runId: 'stale', task: 'task' },
    work(async () => {
      entered();
      await gate;
      return ok();
    }),
  );
  const failed = assert.rejects(pending, /lease was lost/);
  await start;
  const db = new MimirDatabase(f.options.dbPath);
  try {
    db.reasoning.connection.execute(
      'UPDATE n2r_leases SET expires_at=0 WHERE project=? AND agent=?',
      ['demo', 'worker'],
    );
  } finally {
    db.close();
  }
  assert.equal(
    (
      await second.run(
        { runId: 'replacement', task: 'task' },
        work(() => ok()),
      )
    ).success,
    true,
  );
  release();
  await failed;
  assert.equal(
    second.status('stale').calls.find((call) => call.call_id === 'work:0').state,
    'pending',
  );
  assert.equal(second.status('replacement').run.state, 'completed');
});

test('finalization failure rolls back the experience and retries using completed phase receipts', async (t) => {
  const f = fixture(t),
    runner = f.open();
  let executions = 0;
  const db = new MimirDatabase(f.options.dbPath);
  db.reasoning.connection
    .execute(`CREATE TRIGGER reject_n2r_finish BEFORE UPDATE OF state ON n2r_runs
    WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'simulated completion write failure'); END`);
  const request = { runId: 'atomic', task: 'task' },
    handler = work(() => {
      executions++;
      return ok();
    });
  try {
    await assert.rejects(runner.run(request, handler), /simulated completion write failure/);
    assert.equal(db.queryExperiences({ project: 'demo', agent: 'worker' }).length, 0);
    assert.equal(runner.status('atomic').run.state, 'interrupted');
    assert.equal(
      runner.status('atomic').calls.every((call) => call.state === 'completed'),
      true,
    );
    db.reasoning.connection.execute('DROP TRIGGER reject_n2r_finish');
    const receipt = await runner.run(request, handler);
    assert.equal(receipt.success, true);
    assert.equal(executions, 1);
    assert.equal(db.queryExperiences({ project: 'demo', agent: 'worker' }).length, 1);
  } finally {
    db.close();
  }
});

test('returned callbacks wait for queued tools and omitted replay calls fail before verification', async (t) => {
  let writes = 0,
    verified = 0,
    iteration = 0;
  const f = fixture(t, {
      tools: [
        tool('prepare', () => ok()),
        tool('verify', () => {
          verified++;
          return ok();
        }),
        tool('write', async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          writes++;
          return ok('written', ['a.ts']);
        }),
      ],
    }),
    runner = f.open();
  const receipt = await runner.run(
    { runId: 'queued', task: 'task' },
    work((ctx) => {
      ctx.callTool('write');
      return ok();
    }),
  );
  assert.equal(receipt.success, true);
  assert.equal(writes, 1);
  assert.deepEqual(receipt.work.modifiedFiles, ['a.ts']);
  const request = { runId: 'omitted', task: 'task' },
    handler = {
      version: '1',
      idempotent: true,
      execute: async (ctx) => {
        if (++iteration === 1) {
          await ctx.callTool('write');
          throw new Error('stop after child');
        }
        return ok();
      },
    };
  await assert.rejects(runner.run(request, handler), /stop after child/);
  await assert.rejects(runner.run(request, handler), /omitted previously recorded/);
  assert.equal(verified, 1);
});

test('aggregate persistence accepts independently valid context and rich tool data', async (t) => {
  const runner = fixture(t).open();
  const data = Array.from({ length: 3900 }, () => 0);
  const files = Array.from({ length: 200 }, (_, i) => `file-${i}.ts`);
  const receipt = await runner.run(
    { runId: 'aggregate', task: 'task', modifiedFiles: files },
    work(() => ({ success: true, output: 'structured', data })),
  );
  assert.equal(receipt.success, true);
  assert.equal(receipt.work.data.length, 3900);
});

test('missing handlers, cancelled starts, malformed inputs and ambiguous legacy schemas fail explicitly', async (t) => {
  const f = fixture(t),
    runner = f.open({ tools: [] });
  let called = 0;
  await assert.rejects(
    runner.run(
      { runId: 'missing', task: 'task' },
      work(() => {
        called++;
        return ok();
      }),
    ),
    /not registered/,
  );
  assert.equal(called, 0);
  const ready = f.open();
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    ready.run(
      { runId: 'cancelled', task: 'task' },
      work(() => ok()),
      aborted.signal,
    ),
  );
  assert.equal(ready.status('cancelled'), undefined);
  await assert.rejects(
    ready.run(
      { runId: 'bad', task: 'task', modifiedFiles: 'file' },
      work(() => ok()),
    ),
    /modified files/,
  );
  const legacyPath = path.join(f.root, 'legacy.db'),
    db = new MimirDatabase(legacyPath);
  db.reasoning.connection.execute('CREATE TABLE n2r_runs(id TEXT)');
  db.close();
  assert.throws(() => f.open({ dbPath: legacyPath }), /Unversioned/);
});
