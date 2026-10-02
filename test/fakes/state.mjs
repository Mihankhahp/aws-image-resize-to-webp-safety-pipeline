// Shared in-memory AWS state for all fake SDK modules.
import { AsyncLocalStorage } from 'node:async_hooks';

export const als = new AsyncLocalStorage();
export const state = {
  s3: new Map(), // `${bucket}/${key}` -> { body, contentType, metadata, tags: [{Key,Value}] }
  ddb: new Map(), // imageId -> item
  sqs: new Map(), // queueUrl -> [messageBody]
  calls: [], // trace of [t, caller, op, detail]
  latency: () => 1, // (caller, op) => ms
  fail: () => null, // (caller, op) => Error to throw instead of applying op
};
const t0 = Date.now();

export function reset() {
  state.s3.clear();
  state.ddb.clear();
  state.sqs.clear();
  state.calls.length = 0;
  state.latency = () => 1;
  state.fail = () => null;
}

export async function simulate(op, detail, fn) {
  const caller = als.getStore()?.caller ?? 'harness';
  const ms = state.latency(caller, op);
  await new Promise((r) => setTimeout(r, ms));
  const fault = state.fail(caller, op);
  if (fault) {
    state.calls.push([Date.now() - t0, caller, `${op}!FAILED`, detail]);
    throw fault;
  }
  // The server applies the operation at the end of the simulated latency;
  // fn must return fresh objects (no shared references into state).
  const result = fn();
  state.calls.push([Date.now() - t0, caller, op, detail]);
  return result;
}

export const clone = (v) => (v === undefined ? v : structuredClone(v));

export function awsError(name, message) {
  const e = new Error(message);
  e.name = name;
  return e;
}
