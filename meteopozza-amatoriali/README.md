# PozzaLive — stazioni amatoriali di Pozza

Worker indipendente per le due stazioni aggiuntive della pagina principale:

- **Pozza – CEP**, WeatherCloud `9435079591`;
- **Pozza – Netatmo**, Netatmo `70:ee:50:17:9e:ba`.

## Endpoint

- `GET /` e `GET /stations`: snapshot normalizzato;
- `GET /health`: configurazione del servizio, senza chiamate esterne.

Le due fonti vengono interrogate in parallelo e falliscono separatamente. La
cache è fresca per tre minuti e conserva l'ultimo valore valido per sei ore.
La quota WeatherCloud dichiarata dalla sorgente non viene usata perché indica
15 m, valore incompatibile con Pozza di Fassa.

Il frontend può mostrare subito temperatura e umidità e usare gli altri campi
nel dettaglio: pressione, vento, raffica, direzione, pioggia, radiazione solare
e indice UV quando disponibili.

## Verifica locale

```sh
npm test
npm run check
```

Directory radice del progetto Cloudflare:

```text
meteopozza-amatoriali
```
