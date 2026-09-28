# meteomoena-stazioni

Aggrega e normalizza le tre stazioni principali della futura pagina MoenaLive:

- MeteoTrentino `T0096`, Moena - Diga di Pezzè;
- Moena Meteo - Helium2, presentata come Strada de Even;
- MeteoNetwork `TRN352`, Moena - Frazione Pezzè.

Il Worker non interroga direttamente dal browser le fonti originarie: usa i
Service Binding `TRENTINO` e `POZZA`. Il Worker `POZZA` applica a `TRN352` lo
stesso parser MeteoNetwork già utilizzato per Monzon. Il contratto completo e' documentato in
[`../docs/moena-stations-contract.md`](../docs/moena-stations-contract.md).

Endpoint: `/`, `/stations`, `/health`.
