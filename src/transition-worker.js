'use strict';

const {parentPort} = require('node:worker_threads');
const {enumerateTurn, restoreBattle} = require('./showdown-adapter');
const {privateSnapshotKey} = require('./native-memo-key');
const {createPPTransitionCache, auditPPBattle} = require('./pp-transition-cache');
const {auditNativeRules} = require('./native-rules');
const {buildStockProfile} = require('./stock-rule-profile');
const {createEventPlan} = require('./event-plan');

let solvePP = null;
let solvePPAudit = null;
let solveEventPlan = null;

parentPort.postMessage({type: 'ready'});

function serializeError(error) {
  return {name: error.name, message: error.message, stack: error.stack};
}

function runBatch(jobs) {
  return jobs.map(job => {
    try {
      return {id: job.id, result: runTask(job)};
    } catch (error) {
      return {id: job.id, error: serializeError(error)};
    }
  });
}

function runTask(message) {
  const options = {...message.options};
  if (options.outcomeKeyMode === 'private') options.outcomeKey = privateSnapshotKey;
  if (solvePP) {
    options.ppCache = solvePP;
    options.ppAudit = solvePPAudit;
  }
  if (solveEventPlan) options.eventPlan = solveEventPlan;
  delete options.outcomeKeyMode;
  delete options.workerRoute;
  return enumerateTurn(message.snapshot, message.p1Action, message.p2Action, options);
}

parentPort.on('message', message => {
  try {
    if (message.type === 'init-solve') {
      solvePP = null;
      solvePPAudit = null;
      solveEventPlan = null;
      // The PP switch controls only the PP cache. Native method and stock data
      // guards are independent and always run before a worker shares rules.
      const guardedBattle = restoreBattle(message.snapshot);
      // Build from this worker's restored root. This captures the constructed
      // runtime format/cache layout without trusting parent-side references.
      const stockProfile = buildStockProfile();
      const compatible = auditNativeRules(guardedBattle);
      if (compatible) {
        const battle = guardedBattle;
        if (message.enabled) {
          solvePPAudit = auditPPBattle(battle, true);
          if (solvePPAudit) solvePP = createPPTransitionCache();
        }
        solveEventPlan = createEventPlan(battle, true);
      }
      parentPort.postMessage({type: 'solve-ready', id: message.id,
        ppEnabled: !!solvePP, compatible: compatible && (!message.enabled || !!solvePP),
        stockProfile});
      return;
    }
    if (message.type === 'batch') {
      parentPort.postMessage({type: 'batch-result', results: runBatch(message.jobs)});
      return;
    }
    parentPort.postMessage({id: message.id, result: runTask(message)});
  } catch (error) {
    const serialized = serializeError(error);
    if (message.type === 'init-solve') {
      parentPort.postMessage({type: 'solve-error', id: message.id, error: serialized});
    } else if (message.type === 'batch') {
      parentPort.postMessage({type: 'batch-result', results: message.jobs.map(job => ({
        id: job.id, error: serialized,
      }))});
    } else {
      parentPort.postMessage({id: message.id, error: serialized});
    }
  }
});
