#!/usr/bin/env python3
import csv
import io
import json
import tempfile
import zipfile
from pathlib import Path

from build_openov_trip_shapes import build


def decode_polyline(encoded: str, precision: int = 5):
    values = []
    index = 0
    while index < len(encoded):
        value = 0
        shift = 0
        while True:
            chunk = ord(encoded[index]) - 63
            index += 1
            value |= (chunk & 0x1F) << shift
            shift += 5
            if chunk < 0x20:
                break
        values.append(~(value >> 1) if value & 1 else (value >> 1))

    coordinates = []
    lat = 0
    lon = 0
    for i in range(0, len(values), 2):
        lat += values[i]
        lon += values[i + 1]
        coordinates.append((lat / (10 ** precision), lon / (10 ** precision)))
    return coordinates


def main():
    with tempfile.TemporaryDirectory(prefix="ovlive-shape-test-") as temp:
        root = Path(temp)
        archive = root / "sample.zip"
        output = root / "openov-trip-shapes"

        trips = (
            "route_id,service_id,trip_id,shape_id\n"
            "146873,saturday,393481031,shape-a\n"
            "146873,saturday,393481032,shape-a\n"
            "999999,saturday,123456789,shape-b\n"
        )
        shapes = (
            "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n"
            "shape-a,52.10000,5.10000,1\n"
            "shape-a,52.10100,5.10200,2\n"
            "shape-a,52.10300,5.10500,3\n"
            "shape-b,52.20000,5.20000,1\n"
            "shape-b,52.20100,5.20200,2\n"
        )
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("trips.txt", trips)
            zf.writestr("shapes.txt", shapes)

        result = build(archive, output)
        assert result["sampleTrip393481031Present"] is True
        manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
        assert manifest["format"] == 1
        assert manifest["routes"]["146873"]
        shard_path = output / manifest["routes"]["146873"][0]
        shard = json.loads(shard_path.read_text(encoding="utf-8"))
        assert shard["routeId"] == "146873"
        assert shard["trips"]["393481031"] == "shape-a"
        assert shard["trips"]["393481032"] == "shape-a"
        assert list(shard["shapes"].keys()) == ["shape-a"], "shared geometry should not be duplicated in one shard"
        points = decode_polyline(shard["shapes"]["shape-a"], shard["precision"])
        assert len(points) == 3
        assert abs(points[0][0] - 52.1) < 1e-5
        assert abs(points[-1][1] - 5.105) < 1e-5

        print("PASS: exact trip_id + route_id maps to the correct compact GTFS shape")
        print("PASS: trips sharing a shape reuse one polyline")
        print("PASS: polyline preserves ordered latitude/longitude points")
        print("All OpenOV GTFS trip-shape selftests passed.")


if __name__ == "__main__":
    main()
