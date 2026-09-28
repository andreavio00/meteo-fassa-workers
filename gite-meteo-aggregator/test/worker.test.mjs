import assert from "node:assert/strict";
import test from "node:test";

import worker from "../gite-meteo-aggregator.js";


const WEATHER_CLOUD_ID = "6354731265";


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


test("WeatherCloud Sarcine replaces Cima Paradiso in the Moena zone", async () => {
  const originalFetch = globalThis.fetch;
  const epoch = Math.floor(Date.now() / 1000) - 60;

  globalThis.fetch = async (url, options) => {
    assert.equal(
      String(url),
      `https://app.weathercloud.net/device/values/${WEATHER_CLOUD_ID}`
    );
    assert.equal(options?.headers?.["X-Requested-With"], "XMLHttpRequest");

    return Response.json({
      epoch,
      temp: 3.4,
      chill: 2.1,
      dew: 0.4,
      heat: 3.4,
      hum: 81,
      wdir: 290,
      wdiravg: 292.5,
      wspd: 2.2,
      wspdavg: 2.0555556,
      wspdhi: 5.0555556,
      bar: 1018.7,
      rainrate: 0.3,
      rain: 1.2
    });
  };

  try {
    const response = await worker.fetch(
      new Request("https://worker.test/zone/moena_latemar"),
      environment()
    );
    const payload = await response.json();
    const keys = payload.zone.stations.map(station => station.key);

    assert.equal(payload.schema_version, "1.4");
    assert.deepEqual(keys, [
      "fassa:sarcine",
      "fassa:rolle",
      "predazzo:torredipisa",
      "predazzo:passofeudo",
      "predazzo:gardone"
    ]);
    assert.ok(!keys.includes("fassa:paradiso"));

    const sarcine = payload.zone.stations[0];
    assert.equal(sarcine.name, "Sarcine · Passo San Pellegrino");
    assert.equal(sarcine.source, "WeatherCloud");
    assert.equal(
      sarcine.sourceUrl,
      `https://app.weathercloud.net/d${WEATHER_CLOUD_ID}`
    );
    assert.equal(sarcine.status, "online");
    assert.equal(sarcine.temperature, 3.4);
    assert.equal(sarcine.humidity, 81);
    assert.equal(sarcine.wind, 7.4);
    assert.equal(sarcine.windGust, 18.2);
    assert.equal(sarcine.windDirection, "WNW");
    assert.equal(sarcine.precipitation, 1.2);
    assert.equal(sarcine.rainToday, 1.2);
    assert.equal(sarcine.updated, new Date(epoch * 1000).toISOString());
    assert.equal(sarcine.latitude, 46.3758124);
    assert.equal(sarcine.longitude, 11.7500821);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("WeatherCloud observations older than 30 minutes are marked stale", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => Response.json({
    epoch: Math.floor(Date.now() / 1000) - (31 * 60),
    temp: 4.2,
    hum: 76,
    bar: 1015.3
  });

  try {
    const response = await worker.fetch(
      new Request("https://worker.test/zone/moena_latemar"),
      environment()
    );
    const payload = await response.json();
    const sarcine = payload.zone.stations[0];

    assert.equal(sarcine.key, "fassa:sarcine");
    assert.equal(sarcine.status, "stale");
    assert.equal(sarcine.temperature, 4.2);
    assert.ok(sarcine.updated);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("Sarcine remains identified when WeatherCloud is unavailable", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => new Response("", { status: 200 });

  try {
    const response = await worker.fetch(
      new Request("https://worker.test/zone/moena_latemar"),
      environment()
    );
    const payload = await response.json();
    const sarcine = payload.zone.stations[0];

    assert.equal(sarcine.key, "fassa:sarcine");
    assert.equal(sarcine.source, "WeatherCloud");
    assert.equal(sarcine.status, "error");
    assert.equal(sarcine.temperature, null);
    assert.equal(sarcine.updated, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
