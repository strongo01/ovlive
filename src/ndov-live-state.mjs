const DAY_RE = /^(\d{4})-?(\d{2})-?(\d{2})$/;

export function normalizeOperatingDate(value) {
  const raw = String(value ?? '').trim();
  const match = raw.match(DAY_RE);
  return match ? `${match[1]}${match[2]}${match[3]}` : raw;
}

/** Earliest date retained for cross-midnight service and recently-announced trips. */
export function operatingDateRetentionCutoff(value, priorDays = 2) {
  const compact = normalizeOperatingDate(value);
  if (!/^\d{8}$/.test(compact)) return null;
  const year = Number(compact.slice(0, 4));
  const month = Number(compact.slice(4, 6));
  const day = Number(compact.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day - Math.max(0, Math.floor(priorDays))));
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function parseMutationTimestamp(value) {
  if (!value) return null;
  let text = String(value).trim();
  text = text.replace(/\.(\d{3})\d+(?=([+-]\d{2}:?\d{2}|Z)$)/, '.$1');
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizedMutationIdentity(mutation) {
  if (!mutation || mutation.allLines === true || mutation.allJourneysOfLine === true) return null;
  const owner = String(mutation.dataOwnerCode ?? mutation.DataOwnerCode ?? '').trim();
  const date = normalizeOperatingDate(mutation.operationDate ?? mutation.OperationDate);
  const line = String(mutation.linePlanningNumber ?? mutation.LinePlanningNumber ?? '').trim();
  const journey = String(mutation.journeyNumber ?? mutation.JourneyNumber ?? '').trim();
  const reinforcement = String(mutation.reinforcementNumber ?? mutation.fortifyOrderNumber ?? mutation.ReinforcementNumber ?? mutation.FortifyOrderNumber ?? '0').trim() || '0';
  if (!owner || !/^\d{8}$/.test(date) || !line || !journey) return null;
  return [owner, date, line, journey, reinforcement].join('|');
}

function eventSignature(mutation) {
  return [
    mutation.eventType ?? '', mutation.userStopCode ?? '',
    mutation.passageSequenceNumber ?? '', mutation.showCancelledTrip ?? '',
    mutation.reasonContent ?? '',
  ].join('|');
}

/** Keep only the newest KV17 timestamp for each exact trip identity. */
export function upsertCurrentMutationState(states, mutation, limit = 5000) {
  const identity = normalizedMutationIdentity(mutation);
  const timestampMs = parseMutationTimestamp(mutation?.timestamp);
  if (!identity || timestampMs === null) return false;

  const current = states.get(identity);
  let next;
  if (!current || timestampMs > current.timestampMs) {
    next = {
      identity,
      timestamp: String(mutation.timestamp),
      timestampMs,
      events: [mutation],
    };
  } else if (timestampMs < current.timestampMs) {
    return false;
  } else {
    const events = [...current.events];
    const signature = eventSignature(mutation);
    if (events.some((item) => eventSignature(item) === signature)) return false;
    events.push(mutation);
    next = { ...current, events };
  }

  states.delete(identity);
  states.set(identity, next);
  while (states.size > limit) states.delete(states.keys().next().value);
  return true;
}

export function flattenCurrentMutations(states, limit = 300) {
  const events = [];
  for (const state of states.values()) {
    if (Array.isArray(state?.events)) events.push(...state.events);
    else if (state?.eventType) events.push(state); // legacy compatibility
  }
  events.sort((a, b) => (parseMutationTimestamp(a.timestamp) ?? 0) - (parseMutationTimestamp(b.timestamp) ?? 0));
  return events.slice(-limit);
}

export function eventsForIdentities(states, identities, maxIdentities = 20) {
  const selected = [];
  for (const identity of [...new Set(identities)].slice(0, maxIdentities)) {
    const state = states.get(identity);
    if (state && Array.isArray(state.events)) selected.push(...state.events);
    else if (state?.eventType) selected.push(state);
  }
  selected.sort((a, b) => (parseMutationTimestamp(a.timestamp) ?? 0) - (parseMutationTimestamp(b.timestamp) ?? 0));
  return selected;
}

export function normalizeTripLookupIdentity(identity) {
  const parts = String(identity ?? '').split('|');
  if (parts.length !== 5 || parts.some((part) => !part.trim())) return null;
  const [owner, date, line, journey, reinforcement] = parts.map((part) => part.trim());
  const normalizedDate = normalizeOperatingDate(date);
  if (!/^\d{8}$/.test(normalizedDate)) return null;
  return { owner, date: normalizedDate, line, journey, reinforcement: reinforcement || '0' };
}

export function rowMatchesIdentity(row, lookup) {
  if (!row || !lookup) return false;
  return String(row.dataOwnerCode ?? '') === lookup.owner
    && normalizeOperatingDate(row.operationDate) === lookup.date
    && String(row.linePlanningNumber ?? '') === lookup.line
    && String(row.journeyNumber ?? '') === lookup.journey
    && String(row.fortifyOrderNumber ?? row.reinforcementNumber ?? '0') === lookup.reinforcement;
}

function kv78ClockSeconds(value) {
  const match = String(value ?? '').trim().match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  return hour * 3600 + minute * 60 + second;
}

function amsterdamClockSeconds(nowMs) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(nowMs));
  const part = (type) => Number(parts.find((item) => item.type === type)?.value);
  const hour = part('hour'), minute = part('minute'), second = part('second');
  if (![hour, minute, second].every(Number.isFinite)) return null;
  return hour * 3600 + minute * 60 + second;
}

/**
 * KV78 cache key uses the same exact trip identity as live matching.
 * LocalServiceLevelCode is source metadata, not part of the journey identity
 * used downstream, so it must not create duplicate copies of the same stop.
 */
export function kv78RowCacheKey(row) {
  if (!row || typeof row !== 'object') return null;
  const owner = String(row.dataOwnerCode ?? row.DataOwnerCode ?? '').trim().toUpperCase();
  const date = normalizeOperatingDate(row.operationDate ?? row.OperationDate);
  const line = String(row.linePlanningNumber ?? row.LinePlanningNumber ?? '').trim().toUpperCase();
  const journey = String(row.journeyNumber ?? row.JourneyNumber ?? '').trim();
  const reinforcement = String(row.fortifyOrderNumber ?? row.reinforcementNumber ?? row.FortifyOrderNumber ?? row.ReinforcementNumber ?? '0').trim() || '0';
  if (!owner || !/^\d{8}$/.test(date) || !line || !journey) return null;
  const stopOrder = String(row.userStopOrderNumber ?? row.UserStopOrderNumber ?? '').trim();
  const stopCode = String(row.userStopCode ?? row.UserStopCode ?? '').trim();
  const targetArrival = String(row.targetArrivalTime ?? row.TargetArrivalTime ?? '').trim();
  const targetDeparture = String(row.targetDepartureTime ?? row.TargetDepartureTime ?? '').trim();
  const fallbackTime = !stopOrder && !stopCode ? `|${targetArrival}|${targetDeparture}` : '';
  return [owner, date, line, journey, reinforcement, stopOrder, stopCode].join('|') + fallbackTime;
}

/**
 * A stop record is only useful for upcoming-plan matching while at least one
 * target event is still in the schedule matching window. Keep unknown times
 * conservatively so they can still support exact-trip cancellation correlation.
 */
export function isKv78RowScheduleRelevant(row, nowMs = Date.now(), maxPastSeconds = 180) {
  const nowSeconds = amsterdamClockSeconds(nowMs);
  if (nowSeconds === null) return true;
  const eventTimes = [
    kv78ClockSeconds(row?.targetDepartureTime ?? row?.TargetDepartureTime),
    kv78ClockSeconds(row?.targetArrivalTime ?? row?.TargetArrivalTime),
  ].filter((value) => value !== null);
  if (!eventTimes.length) return true;
  return eventTimes.some((targetSeconds) => {
    let delta = targetSeconds - nowSeconds;
    // Only wrap close to midnight; otherwise an old morning stop could appear future.
    if (delta > 64800) delta -= 86400;
    else if (delta < -64800) delta += 86400;
    return delta >= -Math.max(0, maxPastSeconds);
  });
}

export function isRecentIsoTime(value, now = Date.now(), maxAgeMs = 180_000) {
  if (!value) return false;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) && ms <= now + 30_000 && now - ms >= -30_000 && now - ms <= maxAgeMs;
}
