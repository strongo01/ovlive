#!/usr/bin/env python3
"""Build exact OpenOV GTFS trip-to-shape assets for the live vehicle map.

The realtime trip ID and route ID must both match trips.txt from the same
OpenOV GTFS archive. Geometry is encoded as Google polyline precision 5.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import shutil
import sys
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

DEFAULT_GTFS = Path.home() / "Library/Caches/ovlive-ndov/gtfs-openov-nl.zip"
DEFAULT_OUT = Path("public/openov-trip-shapes")
MAX_SHARD_BYTES = 2 * 1024 * 1024
TARGET_TRIPS_PER_SHARD = 400


def find_member(zf: zipfile.ZipFile, basename: str) -> str:
    options = [name for name in zf.namelist()
               if Path(name).name.lower() == basename.lower()]
    if not options:
        raise ValueError(f"{basename} ontbreekt in het GTFS-archief")
    return sorted(options, key=lambda name: ("/" in name, len(name)))[0]


def encode_signed(value: int) -> str:
    value = ~(value << 1) if value < 0 else value << 1
    output = []
    while value >= 0x20:
        output.append(chr((0x20 | (value & 0x1F)) + 63))
        value >>= 5
    output.append(chr(value + 63))
    return "".join(output)


def encode_polyline(points: list[tuple[float, float]]) -> str | None:
    if len(points) < 2:
        return None
    output = []
    last_lat = 0
    last_lon = 0
    for latitude, longitude in points:
        lat = round(latitude * 100000)
        lon = round(longitude * 100000)
        output.append(encode_signed(lat - last_lat))
        output.append(encode_signed(lon - last_lon))
        last_lat = lat
        last_lon = lon
    return "".join(output)


def shard_payload(route_id: str, rows: list[tuple[str, str]], polylines: dict[str, str]) -> dict:
    trip_to_shape = {trip_id: shape_id for trip_id, shape_id in rows}
    used_shape_ids = sorted(set(trip_to_shape.values()))
    return {
        "format": 1,
        "routeId": route_id,
        "trips": trip_to_shape,
        "shapes": {shape_id: polylines[shape_id] for shape_id in used_shape_ids},
        "precision": 5,
    }


def split_route(route_id: str, rows: list[tuple[str, str]], polylines: dict[str, str],
                output_dir: Path, part_start: int = 0) -> list[str]:
    filenames = []
    remaining = rows[:]
    part = part_start
    while remaining:
        chunk_size = min(TARGET_TRIPS_PER_SHARD, len(remaining))
        while True:
            chunk = remaining[:chunk_size]
            payload = shard_payload(route_id, chunk, polylines)
            encoded = (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
            if len(encoded) <= MAX_SHARD_BYTES:
                break
            if chunk_size <= 1:
                raise ValueError(f"Vorm asset voor route {route_id} is groter dan 2 MiB voor één rit.")
            chunk_size = max(1, chunk_size // 2)

        filename = f"route-{route_id}-{part}.json"
        (output_dir / filename).write_bytes(encoded)
        filenames.append(filename)
        del remaining[:chunk_size]
        part += 1
    return filenames


def build(archive: Path, output_dir: Path) -> dict:
    with zipfile.ZipFile(archive) as zf:
        trips_member = find_member(zf, "trips.txt")
        shapes_member = find_member(zf, "shapes.txt")

        trips_by_route: dict[str, list[tuple[str, str]]] = defaultdict(list)
        used_shape_ids: set[str] = set()
        trip_rows = 0
        with zf.open(trips_member) as raw:
            reader = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))
            required = {"trip_id", "route_id", "shape_id"}
            missing = required - set(reader.fieldnames or [])
            if missing:
                raise ValueError("trips.txt mist verplichte kolommen: " + ", ".join(sorted(missing)))
            for row in reader:
                trip_rows += 1
                trip_id = str(row.get("trip_id") or "").strip()
                route_id = str(row.get("route_id") or "").strip()
                shape_id = str(row.get("shape_id") or "").strip()
                if not trip_id or not route_id.isdigit() or not shape_id:
                    continue
                trips_by_route[route_id].append((trip_id, shape_id))
                used_shape_ids.add(shape_id)

        if not trips_by_route or not used_shape_ids:
            raise ValueError("Geen bruikbare GTFS-trips met route_id, trip_id en shape_id gevonden.")

        # The current OpenOV archive has multiple trips per shape. Retain points
        # only for shapes used by trips, then order them by shape_pt_sequence.
        points_by_shape: dict[str, list[tuple[int, float, float]]] = defaultdict(list)
        shape_rows = 0
        with zf.open(shapes_member) as raw:
            reader = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))
            required = {"shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"}
            missing = required - set(reader.fieldnames or [])
            if missing:
                raise ValueError("shapes.txt mist verplichte kolommen: " + ", ".join(sorted(missing)))
            for row in reader:
                shape_id = str(row.get("shape_id") or "").strip()
                if shape_id not in used_shape_ids:
                    continue
                try:
                    sequence = int(row.get("shape_pt_sequence") or "")
                    latitude = float(row.get("shape_pt_lat") or "")
                    longitude = float(row.get("shape_pt_lon") or "")
                except (TypeError, ValueError):
                    continue
                if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
                    continue
                points_by_shape[shape_id].append((sequence, latitude, longitude))
                shape_rows += 1

        polylines: dict[str, str] = {}
        for shape_id, rows in points_by_shape.items():
            rows.sort(key=lambda item: item[0])
            encoded = encode_polyline([(lat, lon) for _, lat, lon in rows])
            if encoded:
                polylines[shape_id] = encoded
        if not polylines:
            raise ValueError("Geen tekenbare GTFS-shapes gevonden; er wordt geen manifest gepubliceerd.")

    build_dir = output_dir.with_name("." + output_dir.name + ".build")
    if build_dir.exists():
        shutil.rmtree(build_dir)
    build_dir.mkdir(parents=True)
    routes_manifest: dict[str, list[str]] = {}
    trip_count = 0
    for route_id, route_rows in sorted(trips_by_route.items(), key=lambda item: int(item[0])):
        usable = sorted(
            ((trip_id, shape_id) for trip_id, shape_id in route_rows if shape_id in polylines),
            key=lambda item: item[0]
        )
        if not usable:
            continue
        filenames = split_route(route_id, usable, polylines, build_dir)
        routes_manifest[route_id] = filenames
        trip_count += len(usable)

    manifest = {
        "format": 1,
        "source": archive.name,
        "sourceModifiedAt": dt.datetime.fromtimestamp(
            archive.stat().st_mtime, dt.timezone.utc
        ).isoformat(timespec="seconds"),
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "precision": 5,
        "routeCount": len(routes_manifest),
        "tripCount": trip_count,
        "shapeCount": len(polylines),
        "routes": routes_manifest,
    }
    (build_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8"
    )
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    if output_dir.exists():
        shutil.rmtree(output_dir)
    build_dir.rename(output_dir)
    return {
        "ok": True,
        "output": str(output_dir),
        "source": archive.name,
        "tripRowsRead": trip_rows,
        "shapeRowsRead": shape_rows,
        "routeCount": len(routes_manifest),
        "tripCount": trip_count,
        "shapeCount": len(polylines),
        "shardCount": sum(len(names) for names in routes_manifest.values()),
        "sampleRoute146873": routes_manifest.get("146873", []),
        "sampleTrip393481031Present": any(
            "393481031" in row for row in trips_by_route.get("146873", [])
        ),
    }


def refresh_archive(archive: Path) -> None:
    url = "https://gtfs.openov.nl/gtfs-rt/gtfs-openov-nl.zip"
    archive.parent.mkdir(parents=True, exist_ok=True)
    temporary = archive.with_suffix(archive.suffix + ".download")
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "OVLive/0.3 (OpenOV GTFS route-shape builder)", "Accept": "application/zip"}
    )
    print("Download actuele OpenOV GTFS-dienstregeling…", file=sys.stderr)
    try:
        with urllib.request.urlopen(request, timeout=120) as response, temporary.open("wb") as target:
            shutil.copyfileobj(response, target, length=1024 * 1024)
        with zipfile.ZipFile(temporary) as zf:
            find_member(zf, "trips.txt")
            find_member(zf, "shapes.txt")
            broken_member = zf.testzip()
            if broken_member:
                raise ValueError("GTFS-zip is beschadigd bij bestand " + broken_member)
        temporary.replace(archive)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gtfs", type=Path, default=DEFAULT_GTFS,
                        help="Pad naar gtfs-openov-nl.zip")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT,
                        help="Uitvoermap binnen public/")
    parser.add_argument("--refresh", action="store_true",
                        help="Download eerst de nieuwste openbare OpenOV GTFS-zip (ongeveer 230 MB)")
    args = parser.parse_args()
    archive = args.gtfs.expanduser().resolve()
    output_dir = args.out_dir.expanduser().resolve()
    if args.refresh:
        try:
            refresh_archive(archive)
        except Exception as exc:
            print(f"FOUT: actuele OpenOV GTFS kon niet worden opgehaald: {exc}", file=sys.stderr)
            return 4
    if not archive.is_file():
        print(f"FOUT: GTFS niet gevonden: {archive}", file=sys.stderr)
        return 2
    try:
        print(json.dumps(build(archive, output_dir), ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        print(f"FOUT: OpenOV-ritvormen niet opgebouwd: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
