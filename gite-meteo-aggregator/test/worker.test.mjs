import assert from "node:assert/strict";
import test from "node:test";

import worker from "../gite-meteo-aggregator.js";


function service(stations) {
  return {
    fetch: async () => Response.json({
      version: "test",
      generatedAt: "2026-09-28T08:30:00Z",
      stations
    })
  };
}


function environment() {
  return {
    FASSA: service([
      { id: "paradiso", name: "Cima Paradiso", status: "online" },
      { id: "rolle", name: "Passo Rolle", status: "online" }
    ]),
    TRENTINO: service([]),
    PREDAZZO: service([
      { id: "torredipisa", name: "Torre di Pisa", status: "online" },
      { id: "passofeudo", name: "Passo Feudo", status: "online" },
      { id: "gardone", name: "Gardone", status: "online" }
    ])
  };
}


test("Sarcine replaces Cima Paradiso in the Moena zone", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async url => {
    assert.match(String(url), /trn362-/);

    return new Response(`
      <button type="button" class="btn btn-success">online</button>
      <div>Temperatura<br>3.4 &deg;C</div>
      <div>4.8 &deg;C</div>
      <div>-1.2 &deg;C</div>
      <div>Umidità<br>81 %</div>
      <div>Pressione<br>1018.7 hPa</div>
      <div>Pioggia<br>1.2 mm (0.3 mm/h)</div>
      <div>Vento<br>7.4 km/h (WNW)</div>
      <div>Raffica 18.2 km/h</div>
      <div>Temp. di rugiada<br>0.4 &deg;C</div>
      <script>
        let maxTHour = 08 - hours;
        let maxTMin = 27 - parseInt(minutes);
        let text = 'Ultimo rilevamento alle ' + ' del ' + '2026-09-28';
      </script>
    `);
  };

  try {
    const response = await worker.fetch(
      new Request("https://worker.test/zone/moena_latemar"),
      environment()
    );
    const payload = await response.json();
    const keys = payload.zone.stations.map(station => station.key);

    assert.deepEqual(keys, [
      "fassa:sarcine",
      "fassa:rolle",
      "predazzo:torredipisa",
      "predazzo:passofeudo",
      "predazzo:gardone"
    ]);
    assert.ok(!keys.includes("fassa:paradiso"));

    const sarcine = payload.zone.stations[0];
    assert.equal(sarcine.name, "Sarcine - Passo San Pellegrino");
    assert.equal(sarcine.status, "online");
    assert.equal(sarcine.temperature, 3.4);
    assert.equal(sarcine.temperatureMin, -1.2);
    assert.equal(sarcine.windDirection, "WNW");
    assert.equal(sarcine.updated, "2026-09-28T08:27:00Z");
    assert.equal(sarcine.latitude, 46.376913);
    assert.equal(sarcine.longitude, 11.751399);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("Sarcine remains identified without inventing data while offline", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => new Response(`
    <button type="button" class="btn btn-danger">offline</button>
    <!-- no current observations -->
  `);

  try {
    const response = await worker.fetch(
      new Request("https://worker.test/zone/moena_latemar"),
      environment()
    );
    const payload = await response.json();
    const sarcine = payload.zone.stations[0];

    assert.equal(sarcine.key, "fassa:sarcine");
    assert.equal(sarcine.status, "offline");
    assert.equal(sarcine.temperature, null);
    assert.equal(sarcine.updated, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
