# AGGIORNAMENTO AUTOMATICO WORKER CLOUDFLARE
Aggiornamento automatico worker per progetto Meteo fassa per dati metereologici e previsioni su Pozza di Fassa e zone limitrofe 
al momento caricati  worker per:
* meteopozza-stazioni
* meteopozza-previsioni
* gite-meteotrentino
* gite-meteo-aggregator
* gite-previsioni-meteoreport
* gite-previsioni-open-meteo
* gite-previsioni-aggregator
* meteo-fassa-previsioni-richiesta


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
