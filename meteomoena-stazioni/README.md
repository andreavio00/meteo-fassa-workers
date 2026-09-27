# meteomoena-stazioni

Aggrega e normalizza le tre stazioni principali della futura pagina MoenaLive:

- MeteoTrentino `T0096`, Moena - Diga di Pezzè;
- Moena Meteo - Helium2;
- MeteoProject - Vigo di Fassa.

Il Worker non interroga direttamente dal browser le fonti originarie: usa i
Service Binding `TRENTINO` e `POZZA`. Il contratto completo e' documentato in
[`../docs/moena-stations-contract.md`](../docs/moena-stations-contract.md).

Endpoint: `/`, `/stations`, `/health`.
