import assert from 'node:assert/strict';
import {
  eventsForIdentities,
  flattenCurrentMutations,
  normalizeOperatingDate,
  normalizeTripLookupIdentity,
  operatingDateRetentionCutoff,
  rowMatchesIdentity,
  upsertCurrentMutationState,
} from '../src/ndov-live-state.mjs';

const identity = 'EBS|20261012|1314|1037|0';
const cancel = {
  dataOwnerCode: 'EBS', operationDate: '2026-10-12', linePlanningNumber: '1314',
  journeyNumber: '1037', reinforcementNumber: '0', eventType: 'CANCEL',
  timestamp: '2026-10-11T13:18:20.240Z',
};
const recoverNewer = { ...cancel, eventType: 'RECOVER', timestamp: '2026-10-11T13:20:00.000Z' };

assert.equal(normalizeOperatingDate('2026-10-12'), '20261012');
assert.equal(operatingDateRetentionCutoff('2026-10-11', 2), '20261009', 'retain current and previous two operating dates');
assert.equal(operatingDateRetentionCutoff('invalid', 2), null);
assert.deepEqual(normalizeTripLookupIdentity(identity), {
  owner: 'EBS', date: '20261012', line: '1314', journey: '1037', reinforcement: '0',
});
console.log('PASS: operating date normalizes and a three-day window covers overnight services');

{
  const states = new Map();
  assert.equal(upsertCurrentMutationState(states, cancel), true);
  assert.equal(upsertCurrentMutationState(states, { ...cancel, eventType: 'CANCEL', timestamp: '2026-10-11T13:17:00.000Z' }), false);
  assert.equal(upsertCurrentMutationState(states, recoverNewer), true);
  const current = eventsForIdentities(states, [identity]);
  assert.equal(current.length, 1);
  assert.equal(current[0].eventType, 'RECOVER');
  console.log('PASS: newer RECOVER replaces an older CANCEL and older events are ignored');
}

{
  const states = new Map();
  upsertCurrentMutationState(states, cancel);
  upsertCurrentMutationState(states, { ...cancel, eventType: 'RECOVER' });
  assert.deepEqual(new Set(eventsForIdentities(states, [identity]).map(e => e.eventType)), new Set(['CANCEL', 'RECOVER']));
  assert.equal(flattenCurrentMutations(states, 20).length, 2);
  console.log('PASS: conflicting actions at the same timestamp are both preserved for safe conflict handling');
}

{
  const lookup = normalizeTripLookupIdentity(identity);
  const good = { dataOwnerCode: 'EBS', operationDate: '2026-10-12', linePlanningNumber: '1314', journeyNumber: '1037', fortifyOrderNumber: '0' };
  assert.equal(rowMatchesIdentity(good, lookup), true);
  assert.equal(rowMatchesIdentity({ ...good, journeyNumber: '1039' }, lookup), false);
  assert.equal(rowMatchesIdentity({ ...good, operationDate: '2026-10-13' }, lookup), false);
  assert.equal(rowMatchesIdentity({ ...good, fortifyOrderNumber: '1' }, lookup), false);
  console.log('PASS: KV78 lookup requires exact owner, operating date, line, journey, and reinforcement');
}

console.log('All NDOV continuous collector selftests passed.');
