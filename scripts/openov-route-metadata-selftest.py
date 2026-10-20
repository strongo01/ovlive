#!/usr/bin/env python3
"""Offline regression test for the lightweight OpenOV route metadata builder."""
from __future__ import annotations

import importlib.util
import json
import tempfile
import zipfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "build-ndov-openov-route-crosswalk.py"
SPEC = importlib.util.spec_from_file_location("openov_route_crosswalk_builder", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Could not load OpenOV route crosswalk builder")
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="ovlive-route-metadata-test-") as temp:
        root = Path(temp)
        archive = root / "fixture-gtfs.zip"
        out_dir = root / "public" / "ndov-openov-route-crosswalk"
        out_dir.mkdir(parents=True)
        existing_manifest = out_dir / "manifest.json"
        existing_manifest.write_text('{"fixture":true}\n', encoding="utf-8")

        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr(
                "routes.txt",
                "route_id,agency_id,route_short_name,route_long_name,route_type\n"
                "160439,operator-a,73,Voorbeeldroute 73,3\n"
                "152327,operator-b,11,Voorbeeldroute 11,3\n",
            )
            zf.writestr(
                "agency.txt",
                "agency_id,agency_name,agency_url,agency_timezone\n"
                "operator-a,U-OV,https://example.invalid/uov,Europe/Amsterdam\n"
                "operator-b,Voorbeeldvervoerder,https://example.invalid/other,Europe/Amsterdam\n",
            )

        result = BUILDER.build_route_metadata(archive, out_dir)
        output = out_dir / "route-metadata.json"
        payload = json.loads(output.read_text(encoding="utf-8"))

        assert result["ok"] is True
        assert payload["format"] == 1
        assert payload["routeCount"] == 2
        assert payload["routes"]["160439"]["routeShortName"] == "73"
        assert payload["routes"]["160439"]["routeLongName"] == "Voorbeeldroute 73"
        assert payload["routes"]["160439"]["agencyName"] == "U-OV"
        assert payload["routes"]["152327"]["routeShortName"] == "11"
        assert existing_manifest.read_text(encoding="utf-8") == '{"fixture":true}\n'

    print("PASS: route IDs are mapped to public GTFS route names and agency metadata")
    print("PASS: metadata-only build leaves existing route manifests and shards untouched")


if __name__ == "__main__":
    main()
