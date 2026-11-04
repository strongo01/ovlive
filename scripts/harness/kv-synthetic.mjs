// Synthetische KV78Turbo/KV6/KV17-berichten (zelfde kolommen als de parser verwacht), deterministisch.
const COLS = ['DataOwnerCode','OperationDate','LocalServiceLevelCode','LinePlanningNumber','JourneyNumber','FortifyOrderNumber','UserStopOrderNumber','UserStopCode','TripStopStatus','VejoJourneyNumber','VehicleJourneyType','VejoTripStatusType','CancelledJourney','ShowCancelledJourney','ShowCancelledTrip','CancelledCall','Monitored','TargetArrivalTime','ExpectedArrivalTime','TargetDepartureTime','ExpectedDepartureTime','LastUpdateTimeStamp','VehicleNumber','ShowCancelledStop','MessageType','MessageContent'];
export function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
const OWN = ['ARR','RIG','GVB','CXX','EBS','QBUZZ','KEOLIS','IVU'];
export function kv78Message(rows, seed, pool, nowIso) {
  const r = rng(seed); const t = (h, m) => `${String(h % 24).padStart(2,'0')}:${String(m % 60).padStart(2,'0')}:00`;
  const lines = ['\\GKV78Turbo|KV8passtimes|' + nowIso, '\\L' + COLS.join('|')];
  for (let i = 0; i < rows; i++) {
    const j = Math.floor(r() * pool), stop = j % 40, cancelled = r() < 0.02 ? 'TRUE' : 'FALSE';
    lines.push([OWN[j % 8], '2026-11-03', '100' + (j % 7), 'L' + (j % 400), String(1000 + ((j / 40 | 0) % 9000)), '0', String(stop), 'NL' + String(100000 + (j % 50000)),
      r() < 0.5 ? 'DRIVING' : 'PLANNED', '0', 'PLANNEDJOURNEY', 'NOTMONITORED', cancelled, 'FALSE', cancelled, cancelled, 'TRUE',
      t(10, stop), t(10, stop + 1 + ((r() * 3) | 0)), t(10, stop), t(10, stop + 1 + ((r() * 3) | 0)), nowIso, 'V' + (j % 3000), 'FALSE', '\\0', r() < 0.01 ? 'Omleiding wegens werkzaamheden aan de lijn' : '\\0'].join('|'));
  }
  return lines.join('\n');
}
export function kv6Message(events, seed, pool, nowIso) {
  const r = rng(seed); let x = '<?xml version="1.0"?><VV_TM_PUSH xmlns="http://bison.connekt.nl/tmi8/kv6/msg">';
  x += '<KV6posinfo>';
  for (let i = 0; i < events; i++) {
    const j = Math.floor(r() * pool), type = ['ONROUTE','ARRIVAL','DEPARTURE','ONSTOP'][(r() * 4) | 0];
    x += `<${type}><dataownercode>${OWN[j % 8]}</dataownercode><lineplanningnumber>L${j % 400}</lineplanningnumber><operatingday>2026-11-03</operatingday><journeynumber>${1000 + j % 9000}</journeynumber><reinforcementnumber>0</reinforcementnumber><userstopcode>NL${100000 + j % 50000}</userstopcode><passagesequencenumber>0</passagesequencenumber><timestamp>${nowIso}</timestamp><source>VEHICLE</source><vehiclenumber>${j % 3000}</vehiclenumber><punctuality>${((r() * 600) | 0) - 120}</punctuality><rd-x>${100000 + ((r() * 100000) | 0)}</rd-x><rd-y>${400000 + ((r() * 100000) | 0)}</rd-y></${type}>`;
  }
  return x + '</KV6posinfo></VV_TM_PUSH>';
}
export function kv17Message(muts, seed, pool, nowIso) {
  const r = rng(seed); let x = '<?xml version="1.0"?><VV_TM_PUSH xmlns="http://bison.connekt.nl/tmi8/kv17/msg"><KV17cvlinfo>';
  for (let i = 0; i < muts; i++) {
    const j = Math.floor(r() * pool), act = r() < 0.7 ? 'CANCEL' : 'RECOVER';
    x += `<KV17MUTATEJOURNEY><dataownercode>${OWN[j % 8]}</dataownercode><lineplanningnumber>L${j % 400}</lineplanningnumber><operatingday>2026-11-03</operatingday><journeynumber>${1000 + j % 9000}</journeynumber><reinforcementnumber>0</reinforcementnumber><timestamp>${nowIso}</timestamp><${act}><reasontype>6</reasontype><reasoncontent>Rit vervalt wegens personeelstekort bij de vervoerder</reasoncontent><advicetype>5</advicetype><advicecontent>Neem de volgende bus of reis met een andere lijn</advicecontent></${act}></KV17MUTATEJOURNEY>`;
  }
  return x + '</KV17cvlinfo></VV_TM_PUSH>';
}
