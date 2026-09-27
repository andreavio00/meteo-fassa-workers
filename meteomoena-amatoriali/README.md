# meteomoena-amatoriali

Raccoglie e normalizza sei stazioni amatoriali di Moena:

- Weather Underground: `IMOENA8`, `IMOENA7`, `IMOENA6`;
- Netatmo: `70:ee:50:01:b2:8a`, `70:ee:50:52:ed:76`,
  `70:ee:50:90:90:e0`.

Le tre pagine Weather Underground sono isolate tra loro. Le tre stazioni
Netatmo condividono una sola richiesta al riquadro pubblico di Moena, ma nello
snapshot mantengono stato ed eventuale fallback individuali.

Il contratto completo e' documentato in
[`../docs/moena-stations-contract.md`](../docs/moena-stations-contract.md).

Endpoint: `/`, `/stations`, `/health`.
