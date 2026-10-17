#!/usr/bin/env python3
"""Build a sharded public asset mapping OpenOV GTFS trip_id -> realtime_trip_id.

The resulting directory is static, public GTFS-derived data. It is not an NDOV
realtime cache. Run it before deployment and whenever the local GTFS-NL archive
is refreshed.
"""
from __future__ import annotations
import argparse
import csv
import datetime as dt
import io
import json
import shutil
import sys
import zipfile
from pathlib import Path

DEFAULT_GTFS = Path.home() / "Library/Caches/ovlive-ndov/gtfs-nl.zip"
DEFAULT_OUT = Path("public/ndov-trip-crosswalk")
# Cloudflare has a per-static-asset size limit. Keep each shard well below it.
MAX_SHARD_BYTES = 12 * 1024 * 1024
INITIAL_PREFIX_LENGTH = 3


def find_member(zf: zipfile.ZipFile, basename: str) -> str:
    options = [n for n in zf.namelist() if Path(n).name.lower() == basename.lower()]
    if not options:
        raise ValueError(f"{basename} ontbreekt in het GTFS-archief")
    return sorted(options, key=lambda n: ("/" in n, len(n)))[0]


def blob_for(mapping: dict[str, str]) -> bytes:
    return json.dumps(mapping, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def partition(prefix: str, items: dict[str, str], used_prefixes: list[str]) -> list[tuple[str, dict[str, str]]]:
    blob = blob_for(items)
    if len(blob) <= MAX_SHARD_BYTES:
        used_prefixes.append(prefix)
        return [(prefix, items)]
    child_groups: dict[str, dict[str, str]] = {}
    for trip_id, realtime_id in items.items():
        if len(trip_id) <= len(prefix):
            # If a single bucket cannot be split further, fail instead of emitting
            # an asset that may exceed Cloudflare's static-asset file-size limit.
            raise ValueError(f"Shard {prefix} is te groot en kan niet verder worden opgesplitst")
        child = trip_id[: len(prefix) + 1]
        child_groups.setdefault(child, {})[trip_id] = realtime_id
    output: list[tuple[str, dict[str, str]]] = []
    for child in sorted(child_groups):
        output.extend(partition(child, child_groups[child], used_prefixes))
    return output


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gtfs", type=Path, default=DEFAULT_GTFS, help="Pad naar gtfs-nl.zip")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT, help="Uitvoermap binnen de statische asset-map")
    args = parser.parse_args()
    archive = args.gtfs.expanduser().resolve()
    out_dir = args.out_dir.expanduser().resolve()
    if not archive.is_file():
        print(f"FOUT: GTFS-bestand niet gevonden: {archive}", file=sys.stderr)
        return 2

    mapping: dict[str, str] = {}
    ambiguous: set[str] = set()
    rows_seen = 0
    with zipfile.ZipFile(archive) as zf:
        trip_member = find_member(zf, "trips.txt")
        with zf.open(trip_member) as raw:
            reader = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))
            fields = set(reader.fieldnames or [])
            if not {"trip_id", "realtime_trip_id"}.issubset(fields):
                print("FOUT: trips.txt mist trip_id of realtime_trip_id.", file=sys.stderr)
                return 3
            for row in reader:
                rows_seen += 1
                trip_id = (row.get("trip_id") or "").strip()
                realtime_id = (row.get("realtime_trip_id") or "").strip()
                # Transitous IDs in this project expose the numeric GTFS-NL trip_id
                # after nl-OpenOV_. Do not create fuzzy or name-based mappings.
                if not trip_id.isdigit() or not realtime_id:
                    continue
                previous = mapping.get(trip_id)
                if previous is not None and previous != realtime_id:
                    ambiguous.add(trip_id)
                    mapping.pop(trip_id, None)
                elif trip_id not in ambiguous:
                    mapping[trip_id] = realtime_id

    if not mapping:
        print("FOUT: geen numerieke trip_id -> realtime_trip_id-koppelingen gevonden.", file=sys.stderr)
        return 4

    # Clean only the generated output folder, never the user's public directory.
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    groups: dict[str, dict[str, str]] = {}
    for trip_id, realtime_id in mapping.items():
        prefix = trip_id[:INITIAL_PREFIX_LENGTH]
        groups.setdefault(prefix, {})[trip_id] = realtime_id

    prefixes: list[str] = []
    shard_count = 0
    total_bytes = 0
    for prefix in sorted(groups):
        for actual_prefix, items in partition(prefix, groups[prefix], prefixes):
            payload = blob_for(items)
            (out_dir / f"trips-{actual_prefix}.json").write_bytes(payload)
            shard_count += 1
            total_bytes += len(payload)

    manifest = {
        "format": 1,
        "source": archive.name,
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "tripRowsScanned": rows_seen,
        "crosswalkRows": len(mapping),
        "ambiguousTripIdsOmitted": len(ambiguous),
        "shardCount": shard_count,
        "shardBytesTotal": total_bytes,
        "shards": sorted(prefixes),
        "note": "Exact GTFS-NL trip_id to realtime_trip_id mapping; public static data, not realtime state.",
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    largest = max((p.stat().st_size for p in out_dir.glob("trips-*.json")), default=0)
    print(json.dumps({
        "ok": True,
        "archive": str(archive),
        "output": str(out_dir),
        "tripRowsScanned": rows_seen,
        "crosswalkRows": len(mapping),
        "ambiguousTripIdsOmitted": len(ambiguous),
        "shardCount": shard_count,
        "totalShardMiB": round(total_bytes / 1024 / 1024, 2),
        "largestShardMiB": round(largest / 1024 / 1024, 2),
        "manifest": str(out_dir / "manifest.json"),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
