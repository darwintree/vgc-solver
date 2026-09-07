'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {backendForResult, parseArgs} = require('../src/benchmark');

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

test('benchmark registers the parallel sucker-punch-6 fixture', () => {
  assert.equal(parseArgs(['--case', 'sucker-punch-6']).fixture, 'sucker-punch-6');
});
