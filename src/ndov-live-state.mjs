const DAY_RE = /^(\d{4})-?(\d{2})-?(\d{2})$/;

// A persisted "enabled" flag is not proof that the live stream is receiving
// messages. Use the last payload time (or session start before the first
// payload) to detect a collector that stopped making progress.
export function continuousCollectorHealth(snapshot, nowMs = Date.now(), maxIdleMs = 150_000) {
  const state = String(snapshot?.state ?? "").toLowerCase();
  const timestampValue = snapshot?.latestMessageAt ?? snapshot?.startedAt;
  const timestampMs = Date.parse(String(timestampValue ?? ""));
  const ageMs = Number.isFinite(timestampMs) ? nowMs - timestampMs : null;
  const ageSeconds = ageMs === null ? null : Math.round(Math.max(0, ageMs) / 1000);

  if (state === "error") {
    return { stale: true, reason: "collector_error", ageSeconds };
  }
  if (ageMs === null) {
    return { stale: true, reason: "missing_activity_timestamp", ageSeconds: null };
  }
  if (ageMs < -30_000) {
    return { stale: true, reason: "activity_timestamp_in_future", ageSeconds };
  }
  if (ageMs > maxIdleMs) {
    return { stale: true, reason: "no_recent_messages", ageSeconds };
  }
  return { stale: false, reason: null, ageSeconds };
}

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
  // KV78 operation-day times may legitimately be expressed as 24:xx or 25:xx
  // for after-midnight service, so do not clamp the hour to a civil clock day.
  if (minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  return hour * 3600 + minute * 60 + second;
}

export function amsterdamClockSeconds(nowMs) {
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
 * Evaluate schedule relevance against one precomputed Amsterdam wall clock.
 * Both target (timetable) and expected (predicted) times are local clock values.
 * This keeps a heavily delayed but still-current prediction in the bounded cache.
 */
export function kv78RowScheduleInfo(
  row, nowSeconds, maxPastSeconds = 180, maxFutureSeconds = 4 * 60 * 60,
) {
  if (!Number.isFinite(nowSeconds)) {
    return { relevant: true, hasScheduleTime: false, distanceSeconds: null };
  }
  // Target times preserve timetable alignment, while expected times preserve
  // a delayed stop that is now expected near the current clock. Keeping only the
  // target time wrongly pruned fresh records once a delay exceeded this past window.
  const eventTimes = [
    kv78ClockSeconds(row?.targetDepartureTime ?? row?.TargetDepartureTime),
    kv78ClockSeconds(row?.targetArrivalTime ?? row?.TargetArrivalTime),
    kv78ClockSeconds(row?.expectedDepartureTime ?? row?.ExpectedDepartureTime),
    kv78ClockSeconds(row?.expectedArrivalTime ?? row?.ExpectedArrivalTime),
  ].filter((value) => value !== null);
  if (!eventTimes.length) {
    // Unknown times are kept until capacity pressure; they cannot be ranked
    // confidently, so the cache-eviction helper will discard them first.
    return { relevant: true, hasScheduleTime: false, distanceSeconds: null };
  }
  const deltas = eventTimes.map((targetSeconds) => {
    let delta = targetSeconds - nowSeconds;
    // Only wrap close to midnight; otherwise an old morning stop could appear future.
    if (delta > 64800) delta -= 86400;
    else if (delta < -64800) delta += 86400;
    return delta;
  });
  const distanceSeconds = Math.min(...deltas.map((delta) => Math.abs(delta)));
  return {
    relevant: deltas.some((delta) =>
      delta >= -Math.max(0, maxPastSeconds) &&
      delta <= Math.max(0, maxFutureSeconds)
    ),
    hasScheduleTime: true,
    distanceSeconds,
  };
}

export function isKv78RowScheduleRelevant(
  row, nowMs = Date.now(), maxPastSeconds = 180,
  nowSeconds = amsterdamClockSeconds(nowMs), maxFutureSeconds = 4 * 60 * 60,
) {
  return kv78RowScheduleInfo(row, nowSeconds, maxPastSeconds, maxFutureSeconds).relevant;
}

/**
 * If capacity is reached, rank by the nearest target OR expected time and
 * evict unknown-time/farthest-away rows first. A late stop predicted for now
 * must outrank an unrelated future stop even when its timetable time has passed.
 */
export function selectKv78RowEvictionKeys(
  entries, limit, nowSeconds, maxPastSeconds = 180, maxFutureSeconds = 4 * 60 * 60,
) {
  // De productiecache is een Map. Gebruik daarvan rechtstreeks de iterator:
  // maak geen tijdelijke array met alle 30.000 entries.
  // Andere iterables blijven compatibel met de bestaande functie.
  const sourceEntries = entries instanceof Map || Array.isArray(entries)
    ? entries
    : Array.from(entries ?? []);
  const entryCount = sourceEntries instanceof Map
    ? sourceEntries.size
    : sourceEntries.length;

  const requestedExcess = Math.max(0, entryCount - Math.max(0, limit));
  const excess = Number.isFinite(requestedExcess)
    ? Math.floor(requestedExcess)
    : 0;

  if (!excess) return [];

  // Sorteervolgorde van de oude implementatie:
  // 1. grootste tijdsafstand eerst;
  // 2. bij gelijke afstand de oudste Map-entry eerst.
  // De heap bewaart alleen de 'excess' hoogst gerangschikte entries.
  const comparePriority = (a, b) => {
    if (a.distanceSeconds > b.distanceSeconds) return -1;
    if (a.distanceSeconds < b.distanceSeconds) return 1;
    return a.index - b.index;
  };

  // Max-heap volgens comparePriority: het minst urgente geselecteerde
  // verwijderitem staat bovenaan en kan efficiënt worden vervangen.
  const heap = [];

  const siftUp = (childIndex) => {
    let child = childIndex;
    while (child > 0) {
      const parent = Math.floor((child - 1) / 2);
      if (comparePriority(heap[child], heap[parent]) <= 0) break;

      const temporary = heap[parent];
      heap[parent] = heap[child];
      heap[child] = temporary;
      child = parent;
    }
  };

  const siftDown = (parentIndex) => {
    let parent = parentIndex;

    while (true) {
      const left = parent * 2 + 1;
      const right = left + 1;
      let worst = parent;

      if (
        left < heap.length &&
        comparePriority(heap[left], heap[worst]) > 0
      ) {
        worst = left;
      }

      if (
        right < heap.length &&
        comparePriority(heap[right], heap[worst]) > 0
      ) {
        worst = right;
      }

      if (worst === parent) break;

      const temporary = heap[parent];
      heap[parent] = heap[worst];
      heap[worst] = temporary;
      parent = worst;
    }
  };

  let index = 0;

  for (const [key, row] of sourceEntries) {
    const info = kv78RowScheduleInfo(
      row, nowSeconds, maxPastSeconds, maxFutureSeconds,
    );

    const candidate = {
      key,
      index,
      distanceSeconds: info.hasScheduleTime
        ? info.distanceSeconds
        : Number.POSITIVE_INFINITY,
    };

    if (heap.length < excess) {
      heap.push(candidate);
      siftUp(heap.length - 1);
    } else if (comparePriority(candidate, heap[0]) < 0) {
      heap[0] = candidate;
      siftDown(0);
    }

    index += 1;
  }

  // Herstel exact de oude verwijdervolgorde.
  heap.sort(comparePriority);
  return heap.map((item) => item.key);
}

export function isRecentIsoTime(value, now = Date.now(), maxAgeMs = 180_000) {
  if (!value) return false;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) && ms <= now + 30_000 && now - ms >= -30_000 && now - ms <= maxAgeMs;
}
