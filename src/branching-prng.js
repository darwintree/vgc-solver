'use strict';

const FIXED_SEED = 'sodium,00000000000000000000000000000000';
const UINT32_SIZE = 1n << 32n;

class NeedRandom extends Error {
  constructor(alternatives) {
    super('The simulator requested another random decision');
    this.name = 'NeedRandom';
    this.alternatives = alternatives;
  }
}

function ceilDiv(a, b) {
  return (a + b - 1n) / b;
}

function bucketProbability(bucket, buckets) {
  const b = BigInt(buckets);
  const low = ceilDiv(BigInt(bucket) * UINT32_SIZE, b);
  const high = ceilDiv(BigInt(bucket + 1) * UINT32_SIZE, b);
  return Number(high - low) / Number(UINT32_SIZE);
}

function chanceProbability(numerator, denominator) {
  const favorable = ceilDiv(BigInt(numerator) * UINT32_SIZE, BigInt(denominator));
  return Number(favorable) / Number(UINT32_SIZE);
}

/**
 * A replayable PRNG facade. Once its supplied decision prefix is exhausted,
 * it throws NeedRandom with the finite alternatives and their probabilities.
 */
class BranchingPRNG {
  constructor(decisions = [], cursor = 0) {
    this.decisions = decisions;
    this.cursor = cursor;
    this.startingSeed = FIXED_SEED;
  }

  _take(kind, key, alternatives) {
    if (this.cursor < this.decisions.length) {
      const decision = this.decisions[this.cursor++];
      if (decision.kind !== kind || decision.key !== key) {
        throw new Error(
          `Random replay diverged at ${this.cursor - 1}: expected ${kind}:${key}, ` +
          `got ${decision.kind}:${decision.key}`
        );
      }
      return decision.value;
    }

    throw new NeedRandom(alternatives.map(({value, probability}) => ({
      decision: {kind, key, value},
      probability,
    })));
  }

  random(from, to) {
    if (from === undefined) {
      throw new Error('Continuous PRNG.random() is not supported by the exact brancher');
    }

    const flooredFrom = Math.floor(from);
    let low;
    let high;
    if (to === undefined || !to) {
      low = 0;
      high = flooredFrom;
    } else {
      low = flooredFrom;
      high = Math.floor(to);
    }

    const count = high - low;
    if (count <= 1) return low;
    if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high)) {
      throw new Error(`Unsupported random range [${low}, ${high})`);
    }

    const alternatives = Array.from({length: count}, (_, bucket) => ({
      value: low + bucket,
      probability: bucketProbability(bucket, count),
    }));
    return this._take('random', `${low}:${high}`, alternatives);
  }

  randomChance(numerator, denominator) {
    if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || denominator <= 0) {
      throw new Error(`Invalid randomChance(${numerator}, ${denominator})`);
    }
    if (numerator <= 0) return false;
    if (numerator >= denominator) return true;

    const p = chanceProbability(numerator, denominator);
    return this._take('chance', `${numerator}:${denominator}`, [
      {value: true, probability: p},
      {value: false, probability: 1 - p},
    ]);
  }

  sample(items) {
    if (!items.length) throw new RangeError('Cannot sample an empty array');
    return items[this.random(items.length)];
  }

  shuffle(items, start = 0, end = items.length) {
    while (start < end - 1) {
      const nextIndex = this.random(start, end);
      if (start !== nextIndex) {
        [items[start], items[nextIndex]] = [items[nextIndex], items[start]];
      }
      start++;
    }
  }

  getSeed() {
    return FIXED_SEED;
  }

  setSeed() {
    this.cursor = 0;
  }

  clone() {
    return new BranchingPRNG(this.decisions, this.cursor);
  }
}

module.exports = {BranchingPRNG, NeedRandom, FIXED_SEED};
