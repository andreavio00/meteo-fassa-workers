# Contratto JSON delle stazioni di Moena

Versione del contratto: **1.0**

Il contratto e' condiviso da:

- `meteomoena-stazioni`, per Diga di Pezzè, Moena Meteo e Vigo di Fassa;
- `meteomoena-amatoriali`, per Weather Underground e Netatmo.

Gli endpoint pubblici sono:

- `GET /` e `GET /stations`: snapshot delle stazioni;
- `GET /health`: configurazione del servizio, senza richieste alle fonti;
- `OPTIONS`: risposta CORS.

## Snapshot

```json
{
  "ok": true,
  "schemaVersion": "1.0",
  "service": "meteomoena-stazioni",
  "generatedAt": "2026-09-27T19:30:00.000Z",
  "fetchedAt": "2026-09-27T19:30:00.000Z",
  "lastRefreshAttemptAt": "2026-09-27T19:30:00.000Z",
  "partial": false,
  "count": 3,
  "online": 3,
  "cache": "MISS",
  "units": {
    "temperature": "°C",
    "pressure": "hPa",
    "wind": "km/h",
    "rain": "mm",
    "solarRadiation": "W/m²"
  },
  "stations": [],
  "sources": [
    {
      "id": "moena-diga-pezze",
      "source": "MeteoTrentino",
      "status": "online",
      "error": null
    }
  ]
}
```

`ok: true` significa che il Worker ha prodotto uno snapshot valido, anche se
una o piu' fonti non sono disponibili. In quel caso `partial` vale `true` e la
singola stazione espone `stale` oppure `offline`. Un errore interno che impedisce
di produrre lo snapshot restituisce HTTP 502 e `ok: false`.

`cache` puo' valere:

- `MISS`: primo recupero;
- `HIT`: snapshot ancora fresco;
- `REFRESH`: cache esistente aggiornata;
- `STALE`: ultimo snapshot conservato dopo un errore recente.

## Stazione normalizzata

Tutte le chiavi metriche sono sempre presenti. Un dato non fornito dalla fonte
vale `null`; il frontend non deve dedurne il valore da un'altra stazione.

```json
{
  "id": "moena-diga-pezze",
  "upstreamId": "T0096",
  "name": "Diga di Pezzè",
  "fullName": "Moena - Diga di Pezzè",
  "category": "official",
  "source": "MeteoTrentino",
  "sourceName": "MeteoTrentino",
  "sourceUrl": "https://www.meteotrentino.it/dati/meteo/ultimi-dati-meteo/",
  "notice": "Stazione ufficiale",
  "status": "online",
  "stale": false,
  "fetchedAt": "2026-09-27T19:30:00.000Z",
  "updatedAt": 1790530200000,
  "updatedAtIso": "2026-09-27T19:30:00.000Z",
  "ageMinutes": 2,
  "latitude": 46.383644,
  "longitude": 11.664651,
  "altitude": 1205,
  "coordinatesApproximate": false,
  "temperature": 11.9,
  "temperatureMin": 11.5,
  "temperatureMax": 12.4,
  "humidity": null,
  "dewPoint": null,
  "windChill": null,
  "heatIndex": null,
  "pressure": null,
  "wind": null,
  "windGust": null,
  "windDirection": null,
  "windDirectionText": null,
  "rainRate": null,
  "rainHour": null,
  "rainToday": 0,
  "solarRadiation": null,
  "uvIndex": null,
  "modules": {
    "temperature": true,
    "humidity": false,
    "pressure": false,
    "rain": true,
    "wind": false,
    "solar": false,
    "uv": false
  },
  "warnings": [],
  "error": null
}
```

### Valori enumerati

`category`:

- `official`: rete pubblica ufficiale;
- `reference`: stazione locale usata come confronto;
- `amateur`: stazione amatoriale.

`status`:

- `online`: dati principali presenti e aggiornati da non piu' di 30 minuti;
- `stale`: ultimo dato noto piu' vecchio di 30 minuti oppure recuperato dalla
  cache dopo un errore;
- `offline`: nessun dato utilizzabile.

Le date sono ISO 8601. `updatedAt` e' lo stesso istante espresso in millisecondi
Unix, mantenuto per semplificare il calcolo dell'eta' nel browser.

## Ordine delle stazioni

`meteomoena-stazioni` restituisce:

1. Diga di Pezzè (`moena-diga-pezze`);
2. Moena Meteo (`moena-meteo`);
3. Vigo di Fassa (`vigo-di-fassa`).

`meteomoena-amatoriali` restituisce tutte e sei le candidate, nell'ordine
iniziale suggerito per l'interfaccia:

1. Lenz (`moena-lenz`);
2. Villa Iellici (`moena-villa-iellici`);
3. Ischiacia (`moena-ischiacia`);
4. Wolf (`moena-wolf`);
5. Lowy (`moena-lowy`);
6. Someda (`moena-someda`).

L'ordine non costituisce una certificazione di qualita'. Il frontend puo'
mostrare solo una parte delle stazioni, ma non deve calcolare una media fra
stazioni ufficiali e amatoriali.
