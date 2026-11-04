import { GtfsRealtimeBindings } from '../fixtures/legacy-gtfs-rt-normalize.mjs';
const rt = GtfsRealtimeBindings.transit_realtime;
// Deterministische pseudo-random zodat oud/nieuw dezelfde invoer krijgen.
function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
export function makeFeedBytes(trips, stopsPerTrip, seed = 1) {
  const r = rng(seed);
  const now = 1793700000;
  const entity = [];
  for (let i = 0; i < trips; i++) {
    const ow = ['ARR','RET','HTM','GVB','CXX','EBS','QBUZZ','KEOLIS'][i % 8];
    const stopTimeUpdate = [];
    const n = Math.max(1, Math.round(stopsPerTrip * (0.5 + r())));
    let delay = Math.round((r() - 0.3) * 240);
    for (let s = 0; s < n; s++) {
      const kind = r();
      const su = { stopSequence: s + 1, stopId: `NL-OpenOV_${ow}:${String(2000000 + ((i * 7 + s * 13) % 90000))}` };
      if (kind < 0.55) { su.arrival = { time: now + i * 3 + s * 120 + delay, delay }; su.departure = { time: now + i * 3 + s * 120 + delay + 20, delay }; }
      else if (kind < 0.85) { su.departure = { time: now + i * 3 + s * 120 + delay }; }
      else if (kind < 0.95) { su.arrival = { delay }; }
      else { su.scheduleRelationship = rt.TripUpdate.StopTimeUpdate.ScheduleRelationship.NO_DATA; }
      if (r() < 0.3) delay += Math.round((r() - 0.5) * 60);
      stopTimeUpdate.push(su);
    }
    entity.push({ id: `${i}`, tripUpdate: {
      trip: { tripId: `${ow}:${String(10000 + (i % 40000))}:${String(100000 + i)}`, routeId: `NL-OpenOV_${ow}:L${i % 900}`, startDate: '20261103', startTime: `${String(5 + (i % 18)).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}:00`, directionId: i % 2, scheduleRelationship: i % 50 === 0 ? rt.TripDescriptor.ScheduleRelationship.CANCELED : rt.TripDescriptor.ScheduleRelationship.SCHEDULED },
      stopTimeUpdate, timestamp: r() < 0.9 ? now - Math.floor(r() * 90) : undefined, delay: r() < 0.5 ? delay : undefined,
      vehicle: r() < 0.6 ? { id: `V${i}` } : undefined } });
  }
  const msg = rt.FeedMessage.create({ header: { gtfsRealtimeVersion: '2.0', incrementality: 0, timestamp: now }, entity });
  return rt.FeedMessage.encode(msg).finish();
}

export function makeAlertFeedBytes(count, seed = 3) {
  const r = rng(seed);
  const entity = [];
  for (let i = 0; i < count; i++) {
    entity.push({ id: `a${i}`, alert: {
      activePeriod: [{ start: 1793700000 + i, end: 1793700000 + i + 3600 }],
      informedEntity: Array.from({ length: 1 + Math.floor(r() * 4) }, (_, k) => ({ agencyId: 'ARR', routeId: `NL-OpenOV_ARR:L${(i + k) % 900}`, stopId: `NL-OpenOV_ARR:${2000000 + k}`, trip: r() < 0.3 ? { tripId: `ARR:${i}:${k}` } : undefined })),
      cause: 1 + Math.floor(r() * 11), effect: 1 + Math.floor(r() * 9),
      headerText: { translation: [{ text: `Storing ${i}`, language: 'en' }, { text: `Verstoring lijn ${i}`, language: 'nl' }] },
      descriptionText: r() < 0.7 ? { translation: [{ text: `Omschrijving ${i} `.repeat(5), language: 'nl' }] } : undefined } });
  }
  return rt.FeedMessage.encode(rt.FeedMessage.create({ header: { gtfsRealtimeVersion: '2.0', incrementality: 0, timestamp: 1793700000 }, entity })).finish();
}
export function makeVehicleFeedBytes(count, seed = 5) {
  const r = rng(seed);
  const entity = [];
  for (let i = 0; i < count; i++) {
    const kind = r();
    entity.push({ id: `v${i}`, vehicle: kind < 0.1 ? {} : { vehicle: { id: `V${i}` }, trip: r() < 0.8 ? { tripId: `ARR:${i}`, routeId: `NL-OpenOV_ARR:L${i % 900}` } : undefined,
      position: r() < 0.9 ? { latitude: 51 + r() * 2, longitude: 3.5 + r() * 3 } : undefined, stopId: r() < 0.5 ? `S${i}` : undefined, timestamp: 1793700000 - Math.floor(r() * 60) } });
  }
  return rt.FeedMessage.encode(rt.FeedMessage.create({ header: { gtfsRealtimeVersion: '2.0', incrementality: 0, timestamp: 1793700000 }, entity })).finish();
}
export { rt };
