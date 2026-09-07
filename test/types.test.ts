import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('compiled declarations preserve solver options and sync/async result types', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'vgc-types-'));
  const modulePath = name => JSON.stringify(path.resolve(__dirname, '../src', name));
  try {
    const source = path.join(directory, 'consumer.ts');
    writeFileSync(source, `
      import {OneVsOneSolver} from ${modulePath('solver')};
      import {BoundedSolver, BoundedResult} from ${modulePath('bounded-solver')};
      import {AsyncBoundedSolver} from ${modulePath('async-bounded-solver')};
      import {solveZeroSumMatrix} from ${modulePath('matrix-game')};
      new OneVsOneSolver({maxStates: 100});
      // @ts-expect-error State limits are numeric.
      new OneVsOneSolver({maxStates: '100'});
      // @ts-expect-error Selection policies are validated names.
      new BoundedSolver({selectionPolicy: 'invalid'});
      // @ts-expect-error Matrix payoffs are numeric.
      solveZeroSumMatrix([['win']]);
      declare const sync: ReturnType<BoundedSolver['solve']>;
      declare const async: ReturnType<AsyncBoundedSolver['solve']>;
      const interval: BoundedResult = sync;
      const pending: Promise<BoundedResult> = async;
      // @ts-expect-error An async interval must be awaited.
      const unawaited: BoundedResult = async;
    `);
    assert.doesNotThrow(() => execFileSync(process.execPath, [
      require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck',
      '--target', 'ES2022', '--module', 'Node16', source,
    ], {stdio: 'pipe'}));
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
