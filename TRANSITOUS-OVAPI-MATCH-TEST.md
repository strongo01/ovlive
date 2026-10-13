# OVLive Transitous ↔ OVAPI-koppelingstest

Dit is een geïsoleerde diagnose in een kopie van de bestaande testkopie. De originele OVLive-map, /api/plan-respons en bestaande OpenOV-statussen worden niet gewijzigd.

## Starten

```bash
cd "/Users/max/Desktop/ovlive-cloudflare-ovapi-crossmatch-copy"
npm install
npm run typecheck
npm run dev
```

Plan eerst een reis van Station Leidsche Rijn naar Duke Ellingtonstraat. Gebruik daarna het paneel Transitous ↔ OVAPI-koppelingstest. Standaardmapping: `utrler` ↔ `nl-OpenOV_3924352`; `utrmyl` ↔ `nl-OpenOV_3924329`.

De matcher gebruikt lijn, lokale datum, geplande tijden binnen ±240 seconden en dezelfde unieke OVAPI-ritidentiteit op beide haltegebieden. Dit is een dienstregelingskandidaat en geen formeel gedeelde rit-ID. Updates ouder dan vijf minuten worden niet als actuele vertraging gebruikt. Endpoint: `POST /api/ovapi-test/match-plan`. Deploy is niet uitgevoerd.
