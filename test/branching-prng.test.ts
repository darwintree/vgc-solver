import assert from 'node:assert/strict';
import test from 'node:test';
import {BranchingPRNG, NeedRandom} from '../src/branching-prng';

function alternatives(draw) {
  try {
    draw(new BranchingPRNG());
    assert.fail('Expected a random branch');
  } catch (error) {
    assert.ok(error instanceof NeedRandom);
    return error.alternatives;
  }
}

test('integer branches preserve exact probabilities and replay each result', () => {
  const branches = alternatives(prng => prng.random(5, 8));
  assert.deepEqual(branches.map(branch => branch.decision.value), [5, 6, 7]);
  assert.deepEqual(branches.map(branch => branch.probability), [
    1431655766 / 2 ** 32, 1431655765 / 2 ** 32, 1431655765 / 2 ** 32,
  ]);
  for (const branch of branches) {
    const prng = new BranchingPRNG([branch.decision]);
    assert.equal(prng.random(5, 8), branch.decision.value);
    assert.equal(prng.cursor, 1);
  }
});

test('chance branches replay, reject divergence and preserve clone position', () => {
  const branches = alternatives(prng => prng.randomChance(1, 3));
  assert.equal(branches[0].probability, 1431655766 / 2 ** 32);
  assert.equal(branches[0].probability + branches[1].probability, 1);
  for (const branch of branches) {
    const prng = new BranchingPRNG([branch.decision, branch.decision]);
    assert.equal(prng.randomChance(1, 3), branch.decision.value);
    const clone = prng.clone();
    assert.equal(clone.randomChance(1, 3), branch.decision.value);
    assert.equal(prng.cursor, 1);
    assert.equal(clone.cursor, 2);
    assert.throws(() => prng.randomChance(1, 9), /Random replay diverged/);
  }
});

test('eager branching continues on the first alternative and clones share the tape', () => {
  const deferred = [];
  const sources = [];
  let probability = 1;
  const onNeedRandom = (alternatives, source) => {
    sources.push(source);
    for (const alternative of alternatives.slice(1)) {
      deferred.push({
        decisions: [...source.decisions, alternative.decision],
        probability: probability * alternative.probability,
      });
    }
    probability *= alternatives[0].probability;
    return alternatives[0];
  };
  const prng = new BranchingPRNG([], 0, onNeedRandom);

  assert.equal(prng.random(5, 8), 5);
  assert.equal(prng.randomChance(1, 3), true);
  assert.equal(prng.cursor, 2);
  assert.equal(prng.decisions.length, 2);
  assert.equal(deferred.length, 3);
  assert.equal(probability, (1431655766 / 2 ** 32) ** 2);

  const clone = prng.clone();
  clone.randomChance(1, 2);
  assert.equal(sources[0], prng);
  assert.equal(sources[2], clone);
  assert.equal(prng.cursor, 2);
  assert.equal(prng.decisions.length, 3);
  assert.equal(clone.cursor, 3);
  assert.equal(clone.decisions.length, 3);

  // A clone and its source at the same cursor consume the same generated
  // tape entry rather than independently selecting another eager branch.
  const source = new BranchingPRNG([], 0, onNeedRandom);
  const sibling = source.clone();
  const value = source.randomChance(1, 2);
  assert.equal(sibling.randomChance(1, 2), value);
  assert.equal(source.decisions.length, 1);
  assert.equal(sibling.cursor, 1);
});
