const decoder = new TextDecoder();

export function decodeUtf8(bytes) {
  return decoder.decode(bytes);
}

function clean(value) {
  if (value == null) return null;
  const v = String(value).replace(/^\uFEFF/, '').trim();
  if (!v || v === '\\0' || v === '\\N') return null;
  return v;
}

/**
 * Retain the timestamp for the last actual Dutch RD coordinate pair.
 * A later KV6 message may update activity/punctuality without containing
 * new coordinates; it must not make an old position look newly observed.
 */
export function mergeKv6PositionMetadata(previous, event, receivedAt) {
  const x = Number(event?.rdX);
  const y = Number(event?.rdY);
  const hasCurrentDutchRdPosition =
    event?.rdX !== null && event?.rdX !== undefined && String(event.rdX).trim() !== "" &&
    event?.rdY !== null && event?.rdY !== undefined && String(event.rdY).trim() !== "" &&
    Number.isFinite(x) && Number.isFinite(y) &&
    x >= 0 && x <= 300000 && y >= 300000 && y <= 650000;

  return {
    rdX: hasCurrentDutchRdPosition ? event.rdX : (previous?.rdX ?? null),
    rdY: hasCurrentDutchRdPosition ? event.rdY : (previous?.rdY ?? null),
    positionTimestamp: hasCurrentDutchRdPosition
      ? (clean(event?.timestamp) ?? receivedAt)
      : (previous?.positionTimestamp ?? null),
    positionReceivedAt: hasCurrentDutchRdPosition
      ? receivedAt
      : (previous?.positionReceivedAt ?? null),
  };
}

function secondsOfDay(v) {
  const s = clean(v);
  if (!s || !/^\d{1,3}:\d{2}:\d{2}$/.test(s)) return null;
  const [h, m, sec] = s.split(':').map(Number);
  if (m > 59 || sec > 59) return null;
  return h * 3600 + m * 60 + sec;
}

function timeDifference(expected, target) {
  const e = secondsOfDay(expected);
  const t = secondsOfDay(target);
  if (e == null || t == null) return null;
  let delta = e - t;
  if (delta < -12 * 3600) delta += 24 * 3600;
  if (delta > 12 * 3600) delta -= 24 * 3600;
  return delta;
}

const KV78_COLUMN_PROPERTIES = new Map([
  ["DataOwnerCode", "dataOwnerCode"],
  ["OperationDate", "operationDate"],
  ["LocalServiceLevelCode", "localServiceLevelCode"],
  ["LinePlanningNumber", "linePlanningNumber"],
  ["JourneyNumber", "journeyNumber"],
  ["FortifyOrderNumber", "fortifyOrderNumber"],
  ["UserStopOrderNumber", "userStopOrderNumber"],
  ["UserStopCode", "userStopCode"],
  ["TripStopStatus", "tripStopStatus"],
  ["VejoJourneyNumber", "vehicleJourneyNumber"],
  ["VehicleJourneyType", "vehicleJourneyType"],
  ["VejoTripStatusType", "vejoTripStatusType"],
  ["CancelledJourney", "cancelledJourney"],
  ["ShowCancelledJourney", "showCancelledJourney"],
  ["ShowCancelledTrip", "showCancelledTrip"],
  ["CancelledCall", "cancelledCall"],
  ["Monitored", "monitored"],
  ["TargetDepartureTime", "targetDepartureTime"],
  ["ExpectedDepartureTime", "expectedDepartureTime"],
  ["TargetArrivalTime", "targetArrivalTime"],
  ["ExpectedArrivalTime", "expectedArrivalTime"],
  ["LastUpdateTimeStamp", "lastUpdateTimeStamp"],
  ["VehicleNumber", "vehicleNumber"],
  ["ShowCancelledStop", "showCancelledStop"],
  ["MessageType", "messageType"],
  ["MessageContent", "messageContent"],
  ["DestinationCode", "destinationCode"],
  ["DestinationName", "destinationName"],
  ["DestinationName50", "destinationName50"],
  ["LinePublicNumber", "linePublicNumber"],
  ["LineName", "lineName"],
  ["TransportType", "transportType"],
  ["OperatorCode", "operatorCode"],
  ["OperatorName", "operatorName"],
  ["BlockCode", "blockCode"],
  ["NumberOfCoaches", "numberOfCoaches"],
  ["TimingPointName", "timingPointName"],
  ["TimingPointTown", "timingPointTown"],
  ["TimingPointCode", "timingPointCode"],
  ["StopAreaCode", "stopAreaCode"],
]);

export function* iterateKv78Payload(text, envelope = '') {
  const source = String(text).replace(/^\uFEFF/, '');

  // Zoek de kopregel zonder eerst alle regels van het bericht te splitsen.
  let scan = 0;
  let headerStart = -1;
  let headerEnd = -1;
  let dataStart = 0;

  while (scan <= source.length) {
    const newline = source.indexOf('\n', scan);
    const rawEnd = newline < 0 ? source.length : newline;
    const lineEnd =
      rawEnd > scan && source.charCodeAt(rawEnd - 1) === 13
        ? rawEnd - 1
        : rawEnd;

    if (
      source.startsWith('\\LDataOwnerCode|', scan) ||
      source.startsWith('\\L|DataOwnerCode|', scan)
    ) {
      headerStart = scan;
      headerEnd = lineEnd;
      dataStart = newline < 0 ? source.length : newline + 1;
      break;
    }

    if (newline < 0) break;
    scan = newline + 1;
  }

  if (headerStart < 0) return;

  const header = source.slice(headerStart + 2, headerEnd).split('|');

  // Bewaar de kolomvolgorde. Bij dubbele kolomnamen moet de laatste
  // waarde winnen, net als bij het oorspronkelijke record-object.
  const selectedColumns = new Map();

  for (let i = 0; i < header.length; i += 1) {
    const property = KV78_COLUMN_PROPERTIES.get(header[i]);
    if (property) selectedColumns.set(i, property);
  }

  let lineStart = dataStart;

  while (lineStart < source.length) {
    const newline = source.indexOf('\n', lineStart);
    const rawEnd = newline < 0 ? source.length : newline;
    const lineEnd =
      rawEnd > lineStart && source.charCodeAt(rawEnd - 1) === 13
        ? rawEnd - 1
        : rawEnd;

    const firstCharacter = source.charCodeAt(lineStart);

    if (
      lineEnd > lineStart &&
      firstCharacter !== 92 &&
      firstCharacter !== 0xfeff
    ) {
      const row = {
        source: 'KV78Turbo',
        envelope,
        identity: undefined,
        dataOwnerCode: undefined,
        operationDate: undefined,
        localServiceLevelCode: undefined,
        linePlanningNumber: undefined,
        journeyNumber: undefined,
        fortifyOrderNumber: undefined,
        userStopOrderNumber: undefined,
        userStopCode: undefined,
        tripStopStatus: undefined,
        vehicleJourneyNumber: null,
        vehicleJourneyType: null,
        vejoTripStatusType: null,
        cancelledJourney: null,
        showCancelledJourney: null,
        showCancelledTrip: null,
        cancelledCall: null,
        monitored: null,
        targetDepartureTime: undefined,
        expectedDepartureTime: undefined,
        targetArrivalTime: undefined,
        expectedArrivalTime: undefined,
        departureDelaySeconds: null,
        arrivalDelaySeconds: null,
        lastUpdateTimeStamp: undefined,
        vehicleNumber: undefined,
        showCancelledStop: null,
        messageType: undefined,
        messageContent: undefined,
        destinationCode: null,
        destinationName: null,
        linePublicNumber: null,
        lineName: null,
        transportType: null,
        operatorCode: null,
        operatorName: null,
        blockCode: null,
        numberOfCoaches: null,
        timingPointName: null,
        timingPointTown: null,
        timingPointCode: null,
        stopAreaCode: null,
      };

      let destinationName50 = null;
      let valueStart = lineStart;
      let valid = true;

      for (let index = 0; index < header.length; index += 1) {
        const separator = source.indexOf('|', valueStart);
        const hasSeparator = separator >= 0 && separator < lineEnd;

        // Een onvolledige regel werd ook door de oude parser geweigerd.
        if (!hasSeparator && index < header.length - 1) {
          valid = false;
          break;
        }

        const valueEnd = hasSeparator ? separator : lineEnd;
        const property = selectedColumns.get(index);

        if (property) {
          const value = clean(source.slice(valueStart, valueEnd));

          if (property === 'destinationName50') {
            destinationName50 = value;
          } else {
            row[property] = value;
          }
        }

        if (!hasSeparator) break;
        valueStart = separator + 1;
      }

      if (
        valid &&
        row.dataOwnerCode &&
        row.operationDate &&
        row.linePlanningNumber &&
        row.journeyNumber
      ) {
        row.identity = [
          row.dataOwnerCode,
          row.operationDate,
          row.localServiceLevelCode,
          row.linePlanningNumber,
          row.journeyNumber,
          row.fortifyOrderNumber ?? '0',
        ].join('|');

        row.departureDelaySeconds = timeDifference(
          row.expectedDepartureTime,
          row.targetDepartureTime
        );

        row.arrivalDelaySeconds = timeDifference(
          row.expectedArrivalTime,
          row.targetArrivalTime
        );

        row.destinationName =
          row.destinationName ?? destinationName50 ?? null;

        row.operatorCode =
          row.operatorCode ?? row.dataOwnerCode ?? null;

        yield row;
      }
    }

    if (newline < 0) break;
    lineStart = newline + 1;
  }
}

// Bestaande API behouden voor tests en eventuele andere gebruikers.
// De realtimecollector gebruikt rechtstreeks de generator hierboven.
export function parseKv78Payload(text, envelope = '') {
  return Array.from(iterateKv78Payload(text, envelope));
}

function tag(xml, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<(?:(?:[A-Za-z_][\\w.-]*):)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[A-Za-z_][\\w.-]*):)?${escaped}\\s*>`, 'i');
  const match = xml.match(re);
  return match ? clean(match[1].replace(/<!\[CDATA\[|\]\]>/g, '')) : null;
}

export function* iterateBisonPayload(text, envelope = '') {
  const xml = String(text);
  const eventRe = /<(?:(?:[A-Za-z_][\w.-]*):)?(ONROUTE|ONSTOP|DEPARTURE|ARRIVAL|OFFROUTE|CANCEL|SHORTENED|INSERT|ADDED|DELAY|CHANGEDESTINATION|INIT|END)\b[^>]*>([\s\S]*?)<\/(?:(?:[A-Za-z_][\w.-]*):)?\1\s*>/gi;
  let match;
  while ((match = eventRe.exec(xml))) {
    const body = match[2];
    const event = {
      source: 'BISON',
      envelope,
      eventType: match[1].toUpperCase(),
      dataOwnerCode: tag(body, 'dataownercode'),
      linePlanningNumber: tag(body, 'lineplanningnumber'),
      operationDate: tag(body, 'operatingday'),
      journeyNumber: tag(body, 'journeynumber'),
      reinforcementNumber: tag(body, 'reinforcementnumber') ?? '0',
      userStopCode: tag(body, 'userstopcode'),
      passageSequenceNumber: tag(body, 'passagesequencenumber'),
      timestamp: tag(body, 'timestamp'),
      sourceType: tag(body, 'source'),
      vehicleNumber: tag(body, 'vehiclenumber'),
      blockCode: tag(body, 'blockcode'),
      punctualitySeconds: (() => {
        const v = tag(body, 'punctuality');
        if (v == null || !/^-?\d+$/.test(v)) return null;
        return Number(v);
      })(),
      distanceSinceLastStop: tag(body, 'distancesincelastuserstop'),
      rdX: tag(body, 'rd-x'),
      rdY: tag(body, 'rd-y'),
    };
    if (event.dataOwnerCode && event.operationDate && event.linePlanningNumber && event.journeyNumber) {
      event.identity = [event.dataOwnerCode, event.operationDate, event.linePlanningNumber, event.journeyNumber, event.reinforcementNumber].join('|');
      yield event;
    }
  }
}

export function parseBisonPayload(text, envelope = '') {
  return Array.from(iterateBisonPayload(text, envelope));
}

export function upsertBounded(map, key, value, limit = 500) {
  map.set(key, value);
  if (map.size > limit) {
    // Keep the newest insertion-order items; Map.set refreshes existing keys below.
    const remove = map.size - limit;
    let i = 0;
    for (const oldKey of map.keys()) {
      map.delete(oldKey);
      if (++i >= remove) break;
    }
  }
}


const KV17_ACTIONS = [
  'CANCEL', 'RECOVER', 'NOTMONITORED', 'SHORTEN', 'LAG',
  'CHANGEPASSTIMES', 'CHANGEDESTINATION', 'MUTATIONMESSAGE', 'ADD',
];

function blocks(xml, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<(?:(?:[A-Za-z_][\\w.-]*):)?${escaped}\\b([^>]*?)(?:\\/\\s*>|>([\\s\\S]*?)<\\/(?:(?:[A-Za-z_][\\w.-]*):)?${escaped}\\s*>)`, 'gi');
  const out = [];
  let match;
  while ((match = re.exec(xml))) out.push(match[2] ?? '');
  return out;
}

function hasEmptyOrPairedTag(xml, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<(?:(?:[A-Za-z_][\\w.-]*):)?${escaped}\\b(?:[^>]*\\/\\s*>|[^>]*>[\\s\\S]*?<\\/(?:(?:[A-Za-z_][\\w.-]*):)?${escaped}\\s*>)`, 'i').test(xml);
}

/**
 * Parse BISON KV17 mutation documents. KV17 describes operational changes,
 * not vehicle positions. It is intentionally exposed as events only: applying
 * these messages to complete itineraries requires trip identity/crosswalk and
 * mutation replacement/recovery semantics outside this diagnostic parser.
 */
export function parseKv17Payload(text, envelope = '') {
  const xml = String(text);
  const journeys = blocks(xml, 'KV17JOURNEY');
  const mutations = blocks(xml, 'KV17MUTATEJOURNEY');
  const events = [];
  const count = Math.max(journeys.length, mutations.length);
  for (let i = 0; i < count; i++) {
    const journey = journeys[i] ?? '';
    const mutation = mutations[i] ?? '';
    const dataOwnerCode = tag(journey, 'dataownercode') ?? tag(mutation, 'dataownercode');
    const operationDate = tag(journey, 'operatingday') ?? tag(mutation, 'operatingday');
    const linePlanningNumber = tag(journey, 'lineplanningnumber') ?? tag(mutation, 'lineplanningnumber');
    const journeyNumber = tag(journey, 'journeynumber') ?? tag(mutation, 'journeynumber');
    const reinforcementNumber = tag(journey, 'reinforcementnumber') ?? tag(mutation, 'reinforcementnumber') ?? '0';
    const allJourneysOfLine = hasEmptyOrPairedTag(journey, 'allJourneysOfLine');
    const allLines = hasEmptyOrPairedTag(journey, 'allLines');
    const timestamp = tag(mutation, 'timestamp');
    const beginTime = tag(journey, 'begintime');
    const endTime = tag(journey, 'endtime');

    for (const actionName of KV17_ACTIONS) {
      for (const actionBody of blocks(mutation, actionName)) {
        const userStopCode = tag(actionBody, 'userstopcode');
        const passageSequenceNumber = tag(actionBody, 'passagesequencenumber');
        const event = {
          source: 'BISON',
          protocol: 'KV17',
          envelope,
          eventType: actionName,
          dataOwnerCode,
          operationDate,
          linePlanningNumber,
          journeyNumber,
          reinforcementNumber,
          allJourneysOfLine,
          allLines,
          beginTime,
          endTime,
          timestamp,
          userStopCode,
          passageSequenceNumber,
          showCancelledTrip: tag(actionBody, 'showcancelledtrip'),
          autoRecover: tag(actionBody, 'autorecover'),
          reasonType: tag(actionBody, 'reasontype'),
          subReasonType: tag(actionBody, 'subreasontype'),
          reasonContent: tag(actionBody, 'reasoncontent'),
          adviceType: tag(actionBody, 'advicetype'),
          subAdviceType: tag(actionBody, 'subadvicetype'),
          adviceContent: tag(actionBody, 'advicecontent'),
          lagSeconds: (() => {
            const raw = tag(actionBody, 'lag') ?? tag(actionBody, 'delay');
            return raw != null && /^-?\d+$/.test(raw) ? Number(raw) : null;
          })(),
          expectedArrivalTime: tag(actionBody, 'targetarrivaltime') ?? tag(actionBody, 'arrivaltime'),
          expectedDepartureTime: tag(actionBody, 'targetdeparturetime') ?? tag(actionBody, 'departuretime'),
          destinationCode: tag(actionBody, 'destinationcode'),
          destinationName: tag(actionBody, 'destinationname'),
        };
        // A broad allLines mutation has no line id; preserve it as a diagnostic
        // event instead of pretending that it belongs to a selected line.
        if (event.dataOwnerCode && event.operationDate && (event.linePlanningNumber || event.allLines)) {
          event.identity = [
            event.dataOwnerCode, event.operationDate,
            event.linePlanningNumber ?? (event.allLines ? '*ALL_LINES*' : ''),
            event.journeyNumber ?? (event.allJourneysOfLine ? '*ALL_JOURNEYS*' : ''),
            event.reinforcementNumber,
          ].join('|');
          events.push(event);
        }
      }
    }
  }
  return events;
}


/**
 * Correlate concrete trip-level KV17 mutations with KV78 stop predictions.
 * Key fields intentionally exclude KV78 LocalServiceLevelCode because KV17
 * does not carry it; matching still requires owner, operating day, line,
 * journey number and reinforcement number to agree exactly.
 * Broad all-lines/all-journeys mutations are excluded from automatic matching.
 */
export function correlateKv17MutationsToKv78Rows(rows, mutations) {
  const concreteKey = (item) => {
    if (!item || item.allLines || item.allJourneysOfLine) return null;
    const owner = clean(item.dataOwnerCode ?? item.DataOwnerCode);
    const rawDate = String(clean(item.operationDate ?? item.OperationDate) ?? '').trim();
    const dateParts = rawDate.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
    const date = dateParts
      ? `${dateParts[1]}${dateParts[2]}${dateParts[3]}`
      : rawDate;
    const line = clean(item.linePlanningNumber ?? item.LinePlanningNumber);
    const journey = clean(item.journeyNumber ?? item.JourneyNumber);
    const reinforcement = clean(item.reinforcementNumber ?? item.fortifyOrderNumber ?? item.ReinforcementNumber ?? item.FortifyOrderNumber) ?? '0';
    if (!owner || !date || !line || !journey) return null;
    return [owner, date, line, journey, reinforcement].join('|');
  };
  const rowsByTrip = new Map();
  for (const row of rows ?? []) {
    const key = concreteKey(row);
    if (!key) continue;
    if (!rowsByTrip.has(key)) rowsByTrip.set(key, []);
    rowsByTrip.get(key).push(row);
  }

  // KV17 is non-stacking: the newest message for an individual journey is the
  // current complete state. Preserve multiple action elements from the same
  // timestamp together, rather than arbitrarily keeping only one action.
  const latestByTrip = new Map();
  let order = 0;
  for (const mutation of mutations ?? []) {
    order += 1;
    const key = concreteKey(mutation);
    if (!key) continue;
    const timestamp = mutation.timestamp ?? null;
    const millis = timestamp ? Date.parse(timestamp) : NaN;
    const rank = Number.isFinite(millis) ? millis : order;
    const existing = latestByTrip.get(key);
    if (!existing || rank > existing.rank) {
      latestByTrip.set(key, { rank, timestamp, mutations: [mutation] });
    } else if (rank === existing.rank) {
      const signature = `${mutation.eventType ?? ''}|${mutation.userStopCode ?? ''}|${mutation.passageSequenceNumber ?? ''}`;
      if (!existing.mutations.some((m) => `${m.eventType ?? ''}|${m.userStopCode ?? ''}|${m.passageSequenceNumber ?? ''}` === signature)) {
        existing.mutations.push(mutation);
      }
    }
  }

  const results = [];
  for (const [identity, current] of latestByTrip) {
    const actions = [...new Set(current.mutations.map((m) => m.eventType).filter(Boolean))].sort();
    const hasCancel = actions.includes('CANCEL');
    const hasRecover = actions.includes('RECOVER');
    const cancelled = hasCancel === hasRecover ? null : hasCancel;
    const matched = rowsByTrip.get(identity) ?? [];
    const statuses = matched.map((r) => r.tripStopStatus).filter(Boolean);
    const first = current.mutations[0];
    let status;
    if (cancelled === true) status = matched.length ? 'cancelled-exact-trip-match' : 'cancelled-no-kv78-row-match';
    else if (cancelled === false) status = matched.length ? 'recovered-exact-trip-match' : 'recovered-no-kv78-row-match';
    else status = matched.length ? 'mutation-exact-trip-match' : 'mutation-no-kv78-row-match';
    results.push({
      identity,
      source: 'KV17+KV78',
      dataOwnerCode: first.dataOwnerCode,
      operationDate: first.operationDate,
      linePlanningNumber: first.linePlanningNumber,
      journeyNumber: first.journeyNumber,
      reinforcementNumber: first.reinforcementNumber ?? '0',
      lastMutationTimestamp: current.timestamp,
      mutationTypes: actions,
      cancelled,
      showCancelledTrip: first.showCancelledTrip ?? null,
      matchedKv78StopCount: matched.length,
      matchedKv78StopCodes: [...new Set(matched.map((r) => r.userStopCode).filter(Boolean))],
      matchedKv78Statuses: [...new Set(statuses)],
      status,
    });
  }
  return results.sort((a, b) => String(b.lastMutationTimestamp ?? '').localeCompare(String(a.lastMutationTimestamp ?? ''))).slice(0, 100);
}
