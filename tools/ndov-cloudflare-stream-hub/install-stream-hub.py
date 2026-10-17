#!/usr/bin/env python3
from pathlib import Path
import shutil
import sys

PACKAGE_DIR = Path(__file__).resolve().parent
EXPECTED_NAME = 'ovlive-cloudflare-ovapi-crossmatch-copy'


def main():
    if len(sys.argv) != 2:
        print('Gebruik: python3 install-stream-hub.py /pad/naar/ovlive-cloudflare-ovapi-crossmatch-copy')
        return 2
    target = Path(sys.argv[1]).expanduser().resolve()
    if target.name != EXPECTED_NAME or not (target / 'package.json').is_file() or not (target / 'wrangler.toml').is_file():
        print(f'STOP: accepteert alleen de lokale testkopie met naam {EXPECTED_NAME}. Er is niets gewijzigd.')
        return 2
    source_root = target / 'tools'
    source_root.mkdir(exist_ok=True)
    destination = source_root / 'ndov-cloudflare-stream-hub'
    if destination.exists():
        print(f'STOP: doelmap bestaat al: {destination}\nEr is niets overschreven. Verwijder of hernoem de testmap handmatig als je opnieuw wilt installeren.')
        return 2
    shutil.copytree(PACKAGE_DIR, destination, ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '.DS_Store'))
    print(f'Toegevoegd: {destination}')
    print('Alleen een nieuwe geïsoleerde testmap toegevoegd. Geen bestaande bestanden aangepast; niets gedeployed.')
    print('Volgende stap: voer scripts/selftest.mjs uit en start Wrangler vanuit deze map.')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
