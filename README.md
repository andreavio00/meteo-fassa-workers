# AGGIORNAMENTO AUTOMATICO WORKER CLOUDFLARE
Aggiornamento automatico worker progetto Meteo fassa per dati metereologici e previsioni su Pozza di Fassa e zone limitrofe 
al momento caricati  worker per:
* meteopozza-stazioni
* meteopozza-previsioni
* gite-meteotrentino
* gite-meteo-aggregator
* gite-previsioni-meteoreport
* gite-previsioni-open-meteo
* gite-previsioni-aggregator
* meteo-fassa-previsioni-richiesta
* meteopozza-amatoriali
* meteomoena-stazioni
* meteomoena-amatoriali
* meteomoena-previsioni

## Worker di Moena

La futura pagina MoenaLive riutilizza i Worker delle escursioni e delle
previsioni su richiesta. I servizi specifici sono:

* `meteomoena-stazioni`: Diga di Pezzè T0096, Strada de Even (Moena Meteo) e Frazione Pezzè TRN352;
* `meteomoena-amatoriali`: tre Weather Underground e tre Netatmo;
* `meteomoena-previsioni`: previsione fissa Meteo.report di Moena.

Il contratto comune delle stazioni e' descritto in
[`docs/moena-stations-contract.md`](docs/moena-stations-contract.md).

## Stazioni MeteoTrentino per le escursioni

`gite-meteotrentino` raccoglie sette stazioni. Tra queste è compresa
`campitello`, stazione MeteoTrentino `T0229`, presentata come **Val Duron –
Malga do Col d’Aura**, situata a 2050 m e utilizzata per la zona Catinaccio.

## Zone dell'aggregatore stazioni

`gite-meteo-aggregator` mantiene le associazioni geografiche senza modificare
i tre Worker sorgente. Gli identificativi coincidono con quelli
dell'aggregatore delle previsioni:

* `catinaccio`
* `sassolungo_sella`
* `marmolada_val_s_nicolo`
* `moena_latemar`

La zona `moena_latemar` riunisce le osservazioni della stazione WeatherCloud
di Sarcine (`6354731265`, settore del Passo San Pellegrino), Passo Rolle e
Latemar. I dati di Sarcine vengono considerati correnti soltanto entro 30 minuti
dall'ultimo aggiornamento. La stazione di Cima Paradiso resta disponibile nel
dataset generale, ma non viene associata al San Pellegrino. L'aggregatore delle previsioni include anche Passo San
Pellegrino e il punto ICON-D2 di Fuciade (46.3930724, 11.8277404), oltre ai
punti già presenti di Costalunga, Rolle e Passo Feudo.

Endpoint principali:

* `/` dataset completo, comprensivo di zone
* `/status` riepilogo delle fonti e delle stazioni
* `/zone/{id}` stazioni di una sola zona
* `/stations` oppure `/?stations` elenco sintetico

Le risposte dalla versione 1.1 aggiungono `schema_version`, `generated_at`,
`timezone`, `zones` e `primary_zone`. I campi precedenti `version`,
`generatedAt`, `count` e `stations` restano disponibili per compatibilità.

La versione 1.2 aggiunge `sourceUrl` a ogni stazione e ai riepiloghi leggeri.
Il campo punta alla pagina pubblica della fonte, adatta a essere aperta dal
frontend; non espone necessariamente l'endpoint tecnico usato per raccogliere
i dati.
