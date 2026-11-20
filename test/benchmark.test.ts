import assert from 'node:assert/strict';
import test from 'node:test';
import {backendForResult, parseArgs} from '../src/benchmark';

test('benchmark backend labels preserve exact fallback and require bounded metadata', () => {
  assert.equal(backendForResult({backend: 'sync'}, 'worker', 'bounded'), 'sync');
  assert.equal(backendForResult({backend: 'fallback'}, 'worker', 'bounded'), 'fallback');
  // A zero-budget worker solve may dispatch no jobs; its explicit result still
  // identifies the worker backend.
  assert.equal(backendForResult({backend: 'worker', stats: {searchMs: 0}}, 'worker', 'bounded'), 'worker');
  assert.throws(
    () => backendForResult({stats: {searchMs: 0}}, 'worker', 'bounded'),
    /missing explicit backend/
  );

  assert.equal(backendForResult({stats: {prepareMs: 10, searchMs: 0}}, 'worker', 'exact'), 'worker');
  assert.equal(backendForResult({stats: {searchMs: 0}}, 'worker', 'exact'), 'fallback');
  assert.equal(backendForResult({stats: {}}, 'sync', 'exact'), 'sync');
});

test('bounded benchmark defaults to the generic adaptive policy', () => {
  assert.equal(parseArgs(['--solver', 'bounded']).selectionPolicy, 'auto');
  assert.equal(parseArgs(['--solver', 'bounded', '--selection-policy', 'joint']).selectionPolicy, 'joint');
  assert.equal(parseArgs(['--solver', 'bounded', '--selection-policy', 'security']).selectionPolicy, 'security');
  assert.throws(
    () => parseArgs(['--solver', 'exact', '--selection-policy', 'auto']),
    /--selection-policy require --solver bounded/
  );
});

test('benchmark registers the parallel sucker-punch-6 fixture and engine selection flag', () => {
  assert.equal(parseArgs(['--case', 'sucker-punch-6']).fixture, 'sucker-punch-6');
  assert.equal(parseArgs(['--solver', 'bounded']).engine, 'auto');
  assert.equal(parseArgs(['--solver', 'bounded', '--engine', 'compact']).engine, 'compact');
  assert.equal(parseArgs(['--solver', 'bounded', '--engine', 'showdown']).engine, 'showdown');
  assert.throws(
    () => parseArgs(['--solver', 'exact', '--engine', 'compact']),
    /--engine require --solver bounded/
  );
});
