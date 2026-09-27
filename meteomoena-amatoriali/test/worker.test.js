import test from "node:test";
import assert from "node:assert/strict";
import worker from "../meteomoena-amatoriali.js";

const nowEpoch = Math.floor(Date.now() / 1000) - 120;
const nowUtc = new Date(nowEpoch * 1000).toUTCString();

const WU_NAMES = {
  IMOENA6: "Wolf-Wetterstation",
  IMOENA7: "Villa Iellici",
  IMOENA8: "Stazione Lenz"
};

function wundergroundHtml(id) {
  const latitude = id === "IMOENA8" ? 46.380035 : 46.377;
  const longitude = id === "IMOENA8" ? 11.665178 : 11.66;
  return `
    <div class="elevation-coordinates">Elev <strong>3969</strong> ft,
      <strong>46.380</strong> °N<strong>11.665</strong> °E</div>
    <li><span>Name:</span><span>${WU_NAMES[id]}</span></li>
    <pws-status data-status="connected" data-obs-time-utc="${nowUtc}"></pws-status>
    <temp-widget-view data-unit="e" data-temp="50" data-feels-like="48"></temp-widget-view>
    <humidity-widget-view data-humidity="80" data-dew-point="44.6"></humidity-widget-view>
    <wind-widget-view data-wind-speed="10" data-wind-gust="15" data-wind-dir="180"></wind-widget-view>
    <rain-widget-view data-precip-rate="0.1" data-precip-total="0.2"></rain-widget-view>
    <pressure-widget-view data-pressure="30"></pressure-widget-view>
    <uv-widget-view data-uv="2"></uv-widget-view>
    <solar-radiation-widget-view data-solar-radiation="240"></solar-radiation-widget-view>
    <wundermap-view data-latitude="${latitude}" data-longitude="${longitude}"></wundermap-view>
  `;
}

function wundergroundAppHtml(id) {
  const state = {
    observations: {
      b: {
        observations: [{
          stationID: id,
          obsTimeUtc: new Date(nowEpoch * 1000).toISOString(),
          epoch: nowEpoch,
          lat: 46.377998,
          lon: 11.657,
          solarRadiationHigh: 0,
          uvHigh: 0,
          winddirAvg: 320,
          humidityHigh: 75,
          humidityLow: 73,
          humidityAvg: 74,
          imperial: {
            tempHigh: 59.2,
            tempLow: 58.8,
            tempAvg: 59,
            windspeedHigh: 1,
            windspeedLow: 0,
            windspeedAvg: 0.5,
            windgustHigh: 2,
            windgustAvg: 1,
            dewptHigh: 50,
            dewptLow: 49,
            dewptAvg: 49.5,
            windchillHigh: 59,
            windchillLow: 58,
            windchillAvg: 58.5,
            heatindexHigh: 59,
            heatindexLow: 58,
            heatindexAvg: 58.5,
            pressureMax: 30.19,
            pressureMin: 30.17,
            precipRate: 0,
            precipTotal: 0
          }
        }]
      }
    },
    summary: {
      b: {
        summaries: [{
          stationID: id,
          epoch: nowEpoch,
          imperial: {
            tempHigh: 76,
            tempLow: 46,
            precipTotal: 0
          }
        }]
      }
    }
  };
  return `<script id="app-root-state" type="application/json">${JSON.stringify(state)}</script>`;
}

function netatmoStation(id, index) {
  const outdoorId = `02:00:00:00:00:0${index + 1}`;
  return {
    _id: id,
    place: {
      city: "Moena",
      altitude: 1177 + index * 20,
      location: [11.660393 + index * 0.003, 46.37588 + index * 0.001]
    },
    module_types: { [outdoorId]: "NAModule1" },
    measures: {
      [id]: {
        type: ["pressure"],
        res: { [nowEpoch]: [1020 + index] }
      },
      [outdoorId]: {
        type: ["temperature", "humidity"],
        res: { [nowEpoch]: [11 + index, 70 + index] }
      }
    }
  };
}

function netatmoPayload(missingId = null) {
  const ids = [
    "70:ee:50:01:b2:8a",
    "70:ee:50:52:ed:76",
    "70:ee:50:90:90:e0"
  ];
  return {
    body: ids
      .filter(id => id !== missingId)
      .map((id, index) => netatmoStation(id, index))
  };
}

function mockFetch(options = {}) {
  return async input => {
    const url = new URL(String(input));
    if (url.hostname === "www.wunderground.com") {
      const id = url.pathname.split("/").pop();
      if (options.failWu === id) return new Response("errore", { status: 503 });
      return new Response(
        id === "IMOENA6" ? wundergroundAppHtml(id) : wundergroundHtml(id),
        { status: 200 }
      );
    }
    if (url.hostname === "auth.netatmo.com") {
      if (options.failNetatmo) return new Response("errore", { status: 503 });
      return Response.json({ body: "public-token" });
    }
    if (url.hostname === "app.netatmo.net") {
      return Response.json(netatmoPayload(options.missingNetatmo));
    }
    throw new Error(`URL inatteso: ${url}`);
  };
}

async function get(path = "/") {
  const response = await worker.fetch(new Request(`https://worker.test${path}`), {}, {});
  return { response, body: await response.json() };
}

test("contratto delle stazioni amatoriali di Moena", async t => {
  await t.test("normalizza tre Weather Underground e tre Netatmo", async () => {
    globalThis.fetch = mockFetch();
    const { response, body } = await get();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.count, 6);
    assert.equal(body.online, 6);
    assert.deepEqual(body.stations.map(station => station.id), [
      "moena-lenz",
      "moena-villa-iellici",
      "moena-ischiacia",
      "moena-wolf",
      "moena-lowy",
      "moena-someda"
    ]);

    const lenz = body.stations[0];
    assert.equal(lenz.temperature, 10);
    assert.equal(lenz.wind, 16.1);
    assert.equal(lenz.windGust, 24.1);
    assert.equal(lenz.pressure, 1015.9);
    assert.equal(lenz.rainToday, 5.1);
    assert.equal(lenz.altitude, 1210);
    assert.equal(lenz.windDirectionText, "S");

    const ischiacia = body.stations[2];
    assert.equal(ischiacia.temperature, 11);
    assert.equal(ischiacia.humidity, 70);
    assert.equal(ischiacia.pressure, 1020);

    const wolf = body.stations[3];
    assert.equal(wolf.temperature, 15);
    assert.equal(wolf.temperatureMin, 7.8);
    assert.equal(wolf.temperatureMax, 24.4);
    assert.equal(wolf.altitude, 1190);
    assert.match(wolf.warnings[0], /5 minuti/i);
  });

  await t.test("il guasto di una PWS non blocca le altre cinque", async () => {
    globalThis.fetch = mockFetch({ failWu: "IMOENA7" });
    const { body } = await get("/stations");

    assert.equal(body.partial, true);
    assert.equal(body.online, 5);
    assert.equal(body.stations.find(station => station.id === "moena-villa-iellici").status, "offline");
    assert.equal(body.stations.find(station => station.id === "moena-lenz").status, "online");
  });

  await t.test("un ID Netatmo assente non nasconde gli altri", async () => {
    globalThis.fetch = mockFetch({ missingNetatmo: "70:ee:50:52:ed:76" });
    const { body } = await get();

    assert.equal(body.stations.find(station => station.id === "moena-lowy").status, "offline");
    assert.equal(body.stations.find(station => station.id === "moena-ischiacia").status, "online");
    assert.equal(body.stations.find(station => station.id === "moena-someda").status, "online");
  });

  await t.test("health non interroga le fonti", async () => {
    globalThis.fetch = async () => { throw new Error("fetch non atteso"); };
    const { response, body } = await get("/health");
    assert.equal(response.status, 200);
    assert.equal(body.service, "meteomoena-amatoriali");
    assert.equal(body.stations.length, 6);
  });

  await t.test("metodi ed endpoint non validi producono errori", async () => {
    const post = await worker.fetch(
      new Request("https://worker.test/", { method: "POST" }),
      {},
      {}
    );
    const missing = await get("/inesistente");
    assert.equal(post.status, 405);
    assert.equal(missing.response.status, 404);
  });
});
