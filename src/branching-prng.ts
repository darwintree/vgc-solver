type RandomValue = number | boolean;
interface Decision {
  kind: string;
  key: string;
  value: RandomValue;
}
interface Alternative {
  decision: Decision;
  probability: number;
}
type RandomHandler = (alternatives: Alternative[], source: BranchingPRNG) => Alternative;

const FIXED_SEED = 'sodium,00000000000000000000000000000000';
const UINT32_SIZE = 1n << 32n;

class NeedRandom extends Error {
  declare alternatives: Alternative[];

  constructor(alternatives: Alternative[]) {
    super('The simulator requested another random decision');
    this.name = 'NeedRandom';
    this.alternatives = alternatives;
  }
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

function bucketProbability(bucket: number, buckets: number): number {
  const b = BigInt(buckets);
  const low = ceilDiv(BigInt(bucket) * UINT32_SIZE, b);
  const high = ceilDiv(BigInt(bucket + 1) * UINT32_SIZE, b);
  return Number(high - low) / Number(UINT32_SIZE);
}

function chanceProbability(numerator: number, denominator: number): number {
  const favorable = ceilDiv(BigInt(numerator) * UINT32_SIZE, BigInt(denominator));
  return Number(favorable) / Number(UINT32_SIZE);
}

/**
 * A replayable PRNG facade. Once its supplied decision prefix is exhausted,
 * it either throws NeedRandom with the finite alternatives or asks the
 * optional onNeedRandom callback to choose one and continue in place.
 */
class BranchingPRNG {
  declare decisions: Decision[];
  declare cursor: number;
  declare onNeedRandom: RandomHandler | null;
  declare startingSeed: string;

  constructor(decisions: Decision[] = [], cursor = 0, onNeedRandom: RandomHandler | null = null) {
    // The tape is shared by clones, matching the simulator PRNG contract:
    // clones at the same cursor observe the same subsequent random values.
    // The eager enumerator gives each branch its own prefix array, so appends
    // do not leak between pending branches.
    this.decisions = decisions;
    this.cursor = cursor;
    this.onNeedRandom = onNeedRandom;
    this.startingSeed = FIXED_SEED;
  }

  _take<T extends RandomValue>(kind: string, key: string, makeAlternatives: () => {value: T; probability: number}[]): T {
    if (this.cursor < this.decisions.length) {
      const decision = this.decisions[this.cursor++];
      if (decision.kind !== kind || decision.key !== key) {
        throw new Error(
          `Random replay diverged at ${this.cursor - 1}: expected ${kind}:${key}, ` +
          `got ${decision.kind}:${decision.key}`
        );
      }
      return decision.value as T;
    }

    const alternatives: Alternative[] = makeAlternatives().map(({value, probability}) => ({
      decision: {kind, key, value},
      probability,
    }));
    if (!this.onNeedRandom) throw new NeedRandom(alternatives);

    const selected = this.onNeedRandom(alternatives, this);
    if (!selected || !alternatives.includes(selected)) {
      throw new Error('onNeedRandom must return one of the supplied alternatives');
    }
    this.decisions.push(selected.decision);
    this.cursor++;
    return selected.decision.value as T;
  }

  random(from?: number, to?: number): number {
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

    return this._take('random', `${low}:${high}`, () => Array.from({length: count}, (_, bucket) => ({
      value: low + bucket,
      probability: bucketProbability(bucket, count),
    })));
  }

  /**
   * Draw an integer bucket and return map(bucket), aggregating buckets with
   * equal mapped values. The mapper must be pure, and label must identify
   * the mapping for replay checks. A representative raw bucket is sufficient
   * only while that mapping remains the same.
   */
  randomMapped<T>(from: number, to: number, map: (value: number) => T, label = 'mapped'): T {
    if (typeof map !== 'function') throw new TypeError('randomMapped requires a mapper');
    if (to === undefined) throw new TypeError('randomMapped requires both from and to');
    const flooredFrom = Math.floor(from);
    const low = flooredFrom;
    const high = Math.floor(to);
    const count = high - low;
    if (count <= 1) return map(low);
    if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high)) {
      throw new Error(`Unsupported random range [${low}, ${high})`);
    }

    const raw = this._groupRaw('random-mapped', `${low}:${high}:${label}`, low, count,
      bucket => map(low + bucket));
    return map(raw);
  }

  /**
   * Group raw integer buckets by an observable class while returning the raw
   * representative. This is useful when a later native pipeline still needs
   * the original random value, but several values are proven equivalent after
   * that pipeline. `group` must be pure and deterministic.
   */
  randomGrouped(from: number, to: number, group: (value: number) => unknown, label = 'grouped'): number {
    if (typeof group !== 'function') throw new TypeError('randomGrouped requires a grouper');
    if (to === undefined) throw new TypeError('randomGrouped requires both from and to');
    const flooredFrom = Math.floor(from);
    const low = flooredFrom;
    const high = Math.floor(to);
    const count = high - low;
    if (count <= 1) return low;
    if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high)) {
      throw new Error(`Unsupported random range [${low}, ${high})`);
    }

    return this._groupRaw('random-grouped', `${low}:${high}:${label}`, low, count, group);
  }

  _groupRaw(kind: string, key: string, low: number, count: number, group: (value: number) => unknown): number {
    const raw = this._take(kind, key, () => {
      const groups = new Map<unknown, {value: number; probability: number}>();
      for (let bucket = 0; bucket < count; bucket++) {
        const rawBucket = low + bucket;
        const key = group(rawBucket);
        const probability = bucketProbability(bucket, count);
        const existing = groups.get(key);
        if (existing) existing.probability += probability;
        else groups.set(key, {value: rawBucket, probability});
      }
      return [...groups.values()];
    });
    return raw;
  }

  randomChance(numerator: number, denominator: number): boolean {
    if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || denominator <= 0) {
      throw new Error(`Invalid randomChance(${numerator}, ${denominator})`);
    }
    if (numerator <= 0) return false;
    if (numerator >= denominator) return true;

    return this._take('chance', `${numerator}:${denominator}`, () => {
      const p = chanceProbability(numerator, denominator);
      return [
        {value: true, probability: p},
        {value: false, probability: 1 - p},
      ];
    });
  }

  sample<T>(items: T[]): T {
    if (!items.length) throw new RangeError('Cannot sample an empty array');
    return items[this.random(items.length)];
  }

  shuffle<T>(items: T[], start = 0, end = items.length): void {
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
    return new BranchingPRNG(this.decisions, this.cursor, this.onNeedRandom);
  }
}

export {BranchingPRNG, NeedRandom, FIXED_SEED};
