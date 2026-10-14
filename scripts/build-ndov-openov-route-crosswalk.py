#!/usr/bin/env python3
"""Build route-specific exact OpenOV GTFS trip patterns for safe BISON fallback matching.

This supplements the numeric GTFS-NL crosswalk. It never creates real-time claims;
the Worker still requires a fresh exact BISON KV6 event before showing a delay.
"""
from __future__ import annotations
import argparse, csv, datetime as dt, hashlib, io, json, re, sys, zipfile
from collections import OrderedDict
from pathlib import Path

DEFAULT_GTFS = Path.home() / "Library/Caches/ovlive-ndov/gtfs-openov-nl.zip"
DEFAULT_OUT = Path("public/ndov-openov-route-crosswalk")
MAX_SHARD_BYTES = 8 * 1024 * 1024
MAX_OPEN_FILES = 48


def find_member(zf: zipfile.ZipFile, basename: str) -> str:
    options = [n for n in zf.namelist() if Path(n).name.lower() == basename.lower()]
    if not options:
        raise ValueError(f"{basename} ontbreekt in het GTFS-archief")
    return sorted(options, key=lambda n: ("/" in n, len(n)))[0]


def realtime_parts(value: str):
    parts = [x.strip() for x in (value or "").split(":")]
    if len(parts) != 3 or not all(parts):
        return None
    return parts


def clock(value):
    if not value:
        return None
    m = re.fullmatch(r"(\d{1,3}):(\d{2}):(\d{2})", value.strip())
    if not m:
        return None
    h, minute, second = map(int, m.groups())
    if minute > 59 or second > 59:
        return None
    return h * 3600 + minute * 60 + second


class RouteShardWriter:
    def __init__(self, out_dir: Path):
        self.out_dir = out_dir
        self.routes_dir = out_dir / "routes"
        self.routes_dir.mkdir(parents=True, exist_ok=True)
        self.states = {}  # route -> part/count/bytes/files
        self.handles = OrderedDict()
        self.signatures = set()
        self.signature_services = {}
        self.pattern_count = 0
        self.total_bytes = 0

    def _path(self, route, part):
        return self.routes_dir / f"route-{route}-{part}.json"

    def _close_lru(self):
        while len(self.handles) >= MAX_OPEN_FILES:
            _, fp = self.handles.popitem(last=False)
            fp.flush(); fp.close()

    def _handle(self, route, part, state):
        key = (route, part)
        if key in self.handles:
            fp = self.handles.pop(key)
            self.handles[key] = fp
            return fp
        self._close_lru()
        path = self._path(route, part)
        if state["counts"].get(part, 0) == 0 and not path.exists():
            fp = open(path, "wb")
            fp.write(b"[")
            state["bytes"][part] = 1
        else:
            fp = open(path, "ab")
        self.handles[key] = fp
        return fp

    def _finalize_part(self, route, part, state):
        key = (route, part)
        fp = self.handles.pop(key, None)
        if fp is not None:
            fp.write(b"]"); fp.flush(); fp.close()
        else:
            with open(self._path(route, part), "ab") as out:
                out.write(b"]")
        state["closed"].add(part)

    def add(self, trip_meta, stops):
        if not trip_meta or len(stops) < 2:
            return
        parts = realtime_parts(trip_meta["realtimeTripId"])
        route = str(trip_meta["routeId"])
        if not parts or not route or not route.isdigit():
            return
        pattern = {
            "routeId": route,
            "realtimeTripId": trip_meta["realtimeTripId"],
            "headsign": trip_meta["headsign"],
            "directionId": trip_meta["directionId"],
            "stops": stops,
        }
        compact = json.dumps(pattern, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        signature = hashlib.sha256(compact).digest()
        service_id = str(trip_meta.get("serviceId") or "").strip()
        if signature in self.signatures:
            if service_id:
                self.signature_services[signature].add(service_id)
            return
        self.signatures.add(signature)
        self.signature_services[signature] = {service_id} if service_id else set()
        state = self.states.setdefault(route, {"part": 0, "counts": {}, "bytes": {}, "files": [], "closed": set(), "signatureLists": {}})
        part = state["part"]
        count = state["counts"].get(part, 0)
        byte_count = state["bytes"].get(part, 0)
        extra = len(compact) + (1 if count else 0)
        if count > 0 and byte_count + extra > MAX_SHARD_BYTES:
            self._finalize_part(route, part, state)
            part += 1
            state["part"] = part
            state["counts"][part] = 0
            state["bytes"][part] = 0
            count = 0
            byte_count = 0
        fp = self._handle(route, part, state)
        if count:
            fp.write(b",")
            self.total_bytes += 1
        fp.write(compact)
        state["counts"][part] = count + 1
        state["signatureLists"].setdefault(part, []).append(signature)
        state["bytes"][part] = state["bytes"].get(part, 0) + extra
        if state["bytes"][part] == 0:
            state["bytes"][part] = 1 + len(compact)
        filename = self._path(route, part).name
        if filename not in state["files"]:
            state["files"].append(filename)
        self.pattern_count += 1
        self.total_bytes += len(compact)

    def finish(self):
        for fp in self.handles.values():
            fp.flush(); fp.close()
        self.handles.clear()
        routes_manifest = {}
        for route, state in sorted(self.states.items(), key=lambda kv: int(kv[0])):
            for part in range(state["part"] + 1):
                if part not in state["closed"]:
                    with open(self._path(route, part), "ab") as out:
                        out.write(b"]")
                    state["closed"].add(part)

                signatures = state["signatureLists"].get(part, [])
                services_path = self._path(route, part).with_name(
                    self._path(route, part).stem + "-services.json"
                )
                services_path.write_text(
                    json.dumps(
                        [sorted(self.signature_services.get(sig, set())) for sig in signatures],
                        separators=(",", ":"),
                    ) + "\n",
                    encoding="utf-8",
                )
            routes_manifest[route] = state["files"]
        return routes_manifest



def _optional_gtfs_rows(zf, basename):
    member = next(
        (name for name in zf.namelist()
         if name.rsplit("/", 1)[-1].lower() == basename.lower()),
        None,
    )
    if member is None:
        return []
    with zf.open(member) as raw:
        return list(csv.DictReader(
            io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
        ))


def build_service_calendar(zf):
    """Build active service IDs by date from GTFS calendar files."""
    calendars = _optional_gtfs_rows(zf, "calendar.txt")
    exceptions = _optional_gtfs_rows(zf, "calendar_dates.txt")
    dates = []

    for row in calendars:
        for field in ("start_date", "end_date"):
            try:
                dates.append(dt.datetime.strptime(
                    row.get(field, ""), "%Y%m%d"
                ).date())
            except (ValueError, TypeError):
                pass

    for row in exceptions:
        try:
            dates.append(dt.datetime.strptime(
                row.get("date", ""), "%Y%m%d"
            ).date())
        except (ValueError, TypeError):
            pass

    if not dates:
        return {}

    first, last = min(dates), max(dates)
    active = {}
    current = first

    while current <= last:
        active[current.strftime("%Y%m%d")] = set()
        current += dt.timedelta(days=1)

    weekdays = (
        "monday", "tuesday", "wednesday", "thursday",
        "friday", "saturday", "sunday",
    )

    for row in calendars:
        service = str(row.get("service_id") or "").strip()
        if not service:
            continue
        try:
            start = dt.datetime.strptime(
                row.get("start_date", ""), "%Y%m%d"
            ).date()
            end = dt.datetime.strptime(
                row.get("end_date", ""), "%Y%m%d"
            ).date()
        except (ValueError, TypeError):
            continue

        current = max(start, first)
        end = min(end, last)

        while current <= end:
            if row.get(weekdays[current.weekday()], "0") == "1":
                active[current.strftime("%Y%m%d")].add(service)
            current += dt.timedelta(days=1)

    for row in exceptions:
        key = str(row.get("date") or "").strip()
        service = str(row.get("service_id") or "").strip()
        kind = str(row.get("exception_type") or "").strip()

        if key not in active or not service:
            continue
        if kind == "1":
            active[key].add(service)
        elif kind == "2":
            active[key].discard(service)

    return {
        key: sorted(services)
        for key, services in active.items()
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gtfs", type=Path, default=DEFAULT_GTFS, help="Pad naar gtfs-openov-nl.zip")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT, help="Outputmap binnen public/")
    args = parser.parse_args()
    archive = args.gtfs.expanduser().resolve()
    out_dir = args.out_dir.expanduser().resolve()
    build_dir = out_dir.parent / ("." + out_dir.name + ".build")
    if not archive.is_file():
        print(f"FOUT: GTFS niet gevonden: {archive}", file=sys.stderr); return 2
    try:
        with zipfile.ZipFile(archive) as zf:
            trips_member = find_member(zf, "trips.txt")
            stops_member = find_member(zf, "stop_times.txt")
            # Metadata memory footprint is limited to trips with a 3-part realtime_trip_id.
            trip_meta = {}
            trip_rows_seen = 0
            with zf.open(trips_member) as raw:
                reader = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))
                required = {"trip_id", "route_id", "realtime_trip_id", "trip_headsign", "direction_id"}
                if not required.issubset(set(reader.fieldnames or [])):
                    raise ValueError("trips.txt mist verplichte kolommen: " + ", ".join(sorted(required - set(reader.fieldnames or []))))
                for row in reader:
                    trip_rows_seen += 1
                    tid = (row.get("trip_id") or "").strip()
                    rid = (row.get("route_id") or "").strip()
                    rt = (row.get("realtime_trip_id") or "").strip()
                    if tid and rid.isdigit() and realtime_parts(rt):
                        trip_meta[tid] = {"routeId": rid, "serviceId": (row.get("service_id") or "").strip(), "realtimeTripId": rt, "headsign": (row.get("trip_headsign") or "").strip(), "directionId": (row.get("direction_id") or "").strip()}
            if not trip_meta:
                raise ValueError("Geen trips met route_id en owner:line:journey realtime_trip_id gevonden.")
            if build_dir.exists():
                # A prior interrupted build is safe to remove; the existing final index remains untouched.
                import shutil
                shutil.rmtree(build_dir)
            writer = RouteShardWriter(build_dir)
            stop_rows_seen = 0
            current_id = None
            current_stops = []
            previous_numeric_id = None
            completed_count = 0
            def finalize(tid, stops):
                nonlocal completed_count
                meta = trip_meta.get(tid)
                if meta:
                    writer.add(meta, sorted(stops, key=lambda stop: stop["stopSequence"]))
                completed_count += 1
            with zf.open(stops_member) as raw:
                reader = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))
                required = {"trip_id", "stop_id", "stop_sequence", "arrival_time", "departure_time"}
                if not required.issubset(set(reader.fieldnames or [])):
                    raise ValueError("stop_times.txt mist vereiste kolommen.")
                for row in reader:
                    stop_rows_seen += 1
                    tid = (row.get("trip_id") or "").strip()
                    if not tid:
                        continue
                    if tid != current_id:
                        if current_id is not None:
                            finalize(current_id, current_stops)
                        # OpenOV's stop_times are grouped by trip_id. Abort instead of
                        # silently building wrong partial journeys if that contract changes.
                        if current_id is not None and current_id.isdigit() and tid.isdigit() and int(tid) < int(current_id):
                            raise ValueError("stop_times.txt is niet gegroepeerd op trip_id; afgebroken om onvolledige patronen te vermijden.")
                        current_id = tid
                        current_stops = []
                    if tid in trip_meta:
                        seq_raw = (row.get("stop_sequence") or "").strip()
                        try: seq = int(seq_raw)
                        except ValueError: continue
                        current_stops.append({
                            "stopId": (row.get("stop_id") or "").strip(),
                            "stopSequence": seq,
                            "arrivalTime": (row.get("arrival_time") or "").strip(),
                            "departureTime": (row.get("departure_time") or "").strip(),
                        })
                if current_id is not None:
                    finalize(current_id, current_stops)
            routes_manifest = writer.finish()
            if not routes_manifest:
                raise ValueError("Geen routepatronen geschreven; controleer de GTFS-feed.")
            service_calendar = build_service_calendar(zf)
            if not service_calendar:
                raise ValueError("Geen bruikbare GTFS-dienstkalender gevonden.")
            build_dir.mkdir(parents=True, exist_ok=True)
            (build_dir / "service-calendar.json").write_text(
                json.dumps(service_calendar, ensure_ascii=False, separators=(",", ":")) + chr(10),
                encoding="utf-8",
            )
            manifest = {
                "format": 1,
                "source": archive.name,
                "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                "tripRowsScanned": trip_rows_seen,
                "tripsWithRealtimeTripId": len(trip_meta),
                "stopTimeRowsScanned": stop_rows_seen,
                "groupedTripsFinalized": completed_count,
                "uniqueRoutePatterns": writer.pattern_count,
                "routeCount": len(routes_manifest),
                "serviceCalendarDateCount": len(service_calendar),
                "routes": routes_manifest,
                "note": "OpenOV GTFS route and full-stop-time crossmatch; static schedule only. Runtime still requires fresh exact BISON KV6 event.",
            }
            (build_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
            total_file_bytes = sum(p.stat().st_size for p in build_dir.rglob("*.json"))
            largest = max((p.stat().st_size for p in (build_dir / "routes").glob("*.json")), default=0)
            # Swap only after a complete, valid build; preserve a rollback copy if replacing an old index.
            old_dir = out_dir.parent / ("." + out_dir.name + ".previous")
            if old_dir.exists():
                import shutil
                shutil.rmtree(old_dir)
            if out_dir.exists():
                out_dir.rename(old_dir)
            try:
                build_dir.rename(out_dir)
            except Exception:
                if old_dir.exists() and not out_dir.exists():
                    old_dir.rename(out_dir)
                raise
            if old_dir.exists():
                import shutil
                shutil.rmtree(old_dir)
            print(json.dumps({"ok": True, "gtfs": str(archive), "output": str(out_dir), "tripRowsScanned": trip_rows_seen,
                "tripsWithRealtimeTripId": len(trip_meta), "stopTimeRowsScanned": stop_rows_seen,
                "uniqueRoutePatterns": writer.pattern_count, "routeCount": len(routes_manifest),
                "totalJsonMiB": round(total_file_bytes/1024/1024, 2), "largestShardMiB": round(largest/1024/1024, 2),
                "manifest": str(out_dir/"manifest.json")}, ensure_ascii=False, indent=2))
            return 0
    except Exception as exc:
        print(f"FOUT: route-crosswalk niet opgebouwd: {exc}", file=sys.stderr)
        return 3

if __name__ == "__main__":
    raise SystemExit(main())
