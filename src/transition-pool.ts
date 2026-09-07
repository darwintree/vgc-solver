import type {Action, Snapshot, Transition, WorkerTransitionOptions} from './types';
import type {buildStockProfile} from './stock-rule-profile';
import * as path from 'node:path';
import {Worker} from 'node:worker_threads';

type StockProfile = ReturnType<typeof buildStockProfile>;
interface WorkerSlot {
  worker: Worker;
  busy: boolean;
  starting: boolean;
  stockProfile?: StockProfile;
  closing?: boolean;
  dead?: boolean;
  index?: number;
  startedAt?: bigint;
}
export interface SolveReady {
  type: 'solve-ready';
  id: number;
  compatible: boolean;
  ppEnabled: boolean;
  stockProfile: StockProfile;
}
interface Job {
  id: number;
  snapshot: Snapshot;
  p1Action: Pick<Action, 'command'>;
  p2Action: Pick<Action, 'command'>;
  options?: WorkerTransitionOptions;
  route?: number;
  resolve: (transition: Transition) => void;
  reject: (error: Error) => void;
}

function restoreError(serialized) {
  return Object.assign(new Error(serialized.message), {
    name: serialized.name,
    stack: serialized.stack,
  });
}

class TransitionPool {
  declare size: number;
  declare batchSize: number;
  declare nextID: number;
  declare nextControlID: number;
  declare workers: WorkerSlot[];
  declare queue: Job[];
  declare pending: Map<number, {slot: WorkerSlot; job: Job}>;
  declare pendingInit: Map<number, {slot: WorkerSlot; resolve: (status: SolveReady) => void; reject: (error: Error) => void}>;
  declare idleWaiters: (() => void)[];
  declare solveLease: boolean;
  declare closed: boolean;
  declare metrics: {
    dispatched: number;
    completed: number;
    peakBusy: number;
    busyMs: number;
    peakQueue: number;
    routedDispatches: number;
    batches: number;
    batchedJobs: number;
  };
  declare ready: Promise<void>;
  declare stockProfile: StockProfile | null;

  constructor(size = 1, {batchSize = 4} = {}) {
    if (!Number.isInteger(size) || size < 1) throw new RangeError('Transition pool size must be a positive integer');
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new RangeError('Transition pool batchSize must be a positive integer');
    }
    this.size = size;
    this.batchSize = batchSize;
    this.nextID = 1;
    this.nextControlID = 1;
    this.workers = [];
    this.queue = [];
    this.pending = new Map();
    this.pendingInit = new Map();
    this.idleWaiters = [];
    this.solveLease = false;
    this.closed = false;
    this.metrics = {
      dispatched: 0, completed: 0, peakBusy: 0, busyMs: 0,
      peakQueue: 0, routedDispatches: 0,
      batches: 0, batchedJobs: 0,
    };
    this.ready = this.start();
  }

  async start() {
    const workerPath = path.join(__dirname, 'transition-worker.js');
    const startup = Array.from({length: this.size}, () => new Promise((resolve, reject) => {
      const worker = new Worker(workerPath);
      const slot: WorkerSlot = {worker, busy: false, starting: true};
      // Record the slot before awaiting startup. If another worker fails,
      // close() must still be able to terminate every already-created thread.
      this.workers.push(slot);
      const startupExit = code => reject(new Error(`Transition worker exited during startup with ${code}`));
      worker.once('exit', startupExit);
      worker.once('message', message => {
        if (message.type !== 'ready') return;
        worker.removeListener('exit', startupExit);
        slot.starting = false;
        slot.stockProfile = message.stockProfile;
        resolve(slot);
      });
      worker.once('error', reject);
    }));
    try {
      await Promise.all(startup);
    } catch (error) {
      this.closed = true;
      await Promise.all(this.workers.map(slot => {
        slot.closing = true;
        return slot.worker.terminate();
      }));
      this.workers = [];
      throw error;
    }
    this.stockProfile = this.workers[0]?.stockProfile || null;
    if (this.closed) {
      await Promise.all(this.workers.map(slot => {
        slot.closing = true;
        return slot.worker.terminate();
      }));
      this.workers = [];
      return;
    }
    this.workers.forEach((slot, index) => { slot.index = index; });
    for (const slot of this.workers) {
      slot.worker.on('message', message => this.finish(slot, message));
      slot.worker.on('error', error => this.failWorker(slot, error));
      slot.worker.on('exit', code => {
        if (!slot.closing) this.failWorker(slot, new Error(`Transition worker exited with ${code}`));
      });
    }
  }

  run(snapshot: Snapshot, p1Action: Pick<Action, 'command'>, p2Action: Pick<Action, 'command'>, options?: WorkerTransitionOptions): Promise<Transition> {
    if (this.closed) return Promise.reject(new Error('Transition pool is closed'));
    const id = this.nextID++;
    return this.ready.then(() => new Promise<Transition>((resolve, reject) => {
      if (this.closed || this.workers.length !== this.size || this.workers.some(slot => slot.dead)) {
        reject(new Error('Transition pool is closed or unavailable'));
        return;
      }
      const route = options && Number.isInteger(options.workerRoute) ? options.workerRoute : undefined;
      if (options && options.workerRoute !== undefined &&
          (route === undefined || route < 0 || route >= this.size)) {
        reject(new RangeError(`Invalid worker route ${options.workerRoute}`));
        return;
      }
      this.queue.push({id, snapshot, p1Action, p2Action, options, route, resolve, reject});
      if (this.queue.length > this.metrics.peakQueue) this.metrics.peakQueue = this.queue.length;
      this.dispatch();
    }));
  }

  async initSolve(snapshot: Snapshot, {enabled = false} = {}) {
    await this.ready;
    if (this.closed) throw new Error('Transition pool is closed');
    if (this.solveLease) throw new Error('Transition pool already has an active solve');
    if (this.workers.some(slot => slot.dead)) throw new Error('Transition pool has a dead worker');
    this.solveLease = true;
    const requests = this.workers.map(slot => new Promise<SolveReady>((resolve, reject) => {
      const id = this.nextControlID++;
      this.pendingInit.set(id, {slot, resolve, reject});
      slot.worker.postMessage({type: 'init-solve', id, snapshot, enabled});
    }));
    try {
      return await Promise.all(requests);
    } catch (error) {
      this.solveLease = false;
      throw error;
    }
  }

  releaseSolve() { this.solveLease = false; }

  waitForIdle() {
    if (!this.queue.length && !this.pending.size) return Promise.resolve();
    return new Promise<void>(resolve => this.idleWaiters.push(resolve));
  }

  notifyIdle() {
    if (this.queue.length || this.pending.size) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  dispatch() {
    for (const slot of this.workers) {
      if (slot.dead || slot.busy || this.queue.length === 0) continue;
      const index = this.queue.findIndex(job => job.route === undefined || job.route === slot.index);
      if (index < 0) continue;
      const [job] = this.queue.splice(index, 1);
      const jobs = [job];
      if (job.route !== undefined) {
        while (jobs.length < this.batchSize) {
          const next = this.queue.findIndex(candidate => candidate.route === job.route);
          if (next < 0) break;
          jobs.push(...this.queue.splice(next, 1));
        }
      }
      if (job.route !== undefined) this.metrics.routedDispatches += jobs.length;
      slot.busy = true;
      slot.startedAt = process.hrtime.bigint();
      this.metrics.dispatched += jobs.length;
      if (jobs.length > 1) {
        this.metrics.batches++;
        this.metrics.batchedJobs += jobs.length;
      }
      const busy = this.workers.filter(candidate => candidate.busy).length;
      if (busy > this.metrics.peakBusy) this.metrics.peakBusy = busy;
      for (const item of jobs) this.pending.set(item.id, {slot, job: item});
      if (jobs.length === 1) {
        slot.worker.postMessage({
          id: job.id,
          snapshot: job.snapshot,
          p1Action: job.p1Action,
          p2Action: job.p2Action,
          options: job.options,
        });
      } else {
        slot.worker.postMessage({type: 'batch', jobs: jobs.map(item => ({
          id: item.id, snapshot: item.snapshot,
          p1Action: item.p1Action, p2Action: item.p2Action, options: item.options,
        }))});
      }
    }
  }

  finish(slot, message) {
    if (message.type === 'ready') return;
    if (message.type === 'solve-ready' || message.type === 'solve-error') {
      const init = this.pendingInit.get(message.id);
      if (!init) return;
      this.pendingInit.delete(message.id);
      if (message.error) init.reject(restoreError(message.error));
      else init.resolve(message);
      return;
    }
    if (message.type === 'batch-result') {
      slot.busy = false;
      this.metrics.busyMs += Number(process.hrtime.bigint() - slot.startedAt) / 1e6;
      for (const result of message.results) {
        const entry = this.pending.get(result.id);
        if (!entry) continue;
        this.pending.delete(result.id);
        this.metrics.completed++;
        if (result.error) entry.job.reject(restoreError(result.error));
        else entry.job.resolve(result.result);
      }
      this.dispatch();
      this.notifyIdle();
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    slot.busy = false;
    this.metrics.completed++;
    this.metrics.busyMs += Number(process.hrtime.bigint() - slot.startedAt) / 1e6;
    if (message.error) {
      entry.job.reject(restoreError(message.error));
    } else {
      entry.job.resolve(message.result);
    }
    this.dispatch();
    this.notifyIdle();
  }

  failWorker(slot, error) {
    if (slot.dead || slot.closing) return;
    slot.dead = true;
    this.closed = true;
    const failure = new Error(`Transition pool worker failed: ${error.message}`);
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      entry.job.reject(failure);
    }
    for (const [id, init] of this.pendingInit) {
      this.pendingInit.delete(id);
      init.reject(failure);
    }
    for (const job of this.queue.splice(0)) job.reject(failure);
    this.solveLease = false;
    for (const candidate of this.workers) {
      if (candidate !== slot) {
        candidate.closing = true;
        candidate.worker.terminate();
      }
    }
    this.notifyIdle();
  }

  async close() {
    this.closed = true;
    const error = new Error('Transition pool is closed');
    for (const job of this.queue.splice(0)) job.reject(error);
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      entry.job.reject(error);
    }
    for (const [id, init] of this.pendingInit) {
      this.pendingInit.delete(id);
      init.reject(error);
    }
    this.solveLease = false;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
    await this.ready.catch(() => {});
    await Promise.all(this.workers.map(slot => {
      slot.closing = true;
      return slot.worker.terminate();
    }));
    this.workers = [];
  }
}

export {TransitionPool};
