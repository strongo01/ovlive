# OVLive — geïsoleerde OVAPI-integratietest

Dit is een kopie van je bestaande OVLive-project met een losse module `src/ovapi-test.ts` en eigen routes `/api/ovapi-test/*`. De bestaande OpenOV-enrichment, `/api/plan` en bestaande realtimeweergave worden niet gewijzigd. Alleen de kopie heeft de Worker-naam `ovlive-ovapi-test`, zodat een latere deploy je bestaande Worker niet overschrijft.

## Eerst lokaal testen

```bash
cd /Users/max/Desktop/ovlive-cloudflare-ovapi-test-copy
npm install
npm run typecheck
npm run dev
```

Open de lokale URL die Wrangler toont. De nieuwe OVAPI-test staat onderaan de startpagina. Voor een directe health-check open je `/api/ovapi-test/health`.

## Eigen endpoints

- `/api/ovapi-test/health` — moduleconfiguratie
- `/api/ovapi-test/departures?code=utrmyl` — passages voor één haltegebied
- `/api/ovapi-test/compare?from=utrler&to=utrmyl&line=5` — vergelijking van dezelfde rit tussen twee haltegebieden

De vergelijker koppelt alleen wanneer `OperationDate`, `DataOwnerCode`, `LinePlanningNumber` en `JourneyNumber` allebei aanwezig zijn en de identiteit aan beide haltes uniek is. Updates ouder dan 5 minuten zijn niet bruikbaar als actuele vertraging of bevestigde annulering. De vijf minuten zijn een conservatieve testdrempel, geen garantie van de bron. Upstream-antwoorden worden maximaal 60 seconden door Cloudflare gecachet; er wordt geen historie opgeslagen. De KV78Turbo-OVAPI-documentatie vraagt om gzip, een herkenbare User-Agent en terughoudend gebruik van de publieke dienst.

## Bestaande bestanden veilig houden

De originele map `/Users/max/Desktop/ovlive-cloudflare` is niet aangepast. Werk alleen in deze kopie totdat de resultaten overtuigend zijn. Deploy nog niet voordat de lokale test is gecontroleerd.
