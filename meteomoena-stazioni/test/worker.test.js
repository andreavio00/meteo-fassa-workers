import test from "node:test";
import assert from "node:assert/strict";
import worker from "../meteomoena-stazioni.js";

const updated = new Date(Date.now() - 2 * 60_000).toISOString();

function trentinoPayload() {
  return {
    id: "moena",
    code: "T0096",
    name: "Moena (Diga Pezzè)",
    altitude: 1205,
    latitude: 46.383644,
    longitude: 11.664651,
    source: "MeteoTrentino",
    status: "online",
    updated,
    temperature: 11.9,
    temperatureMin: 7.2,
    temperatureMax: 16.4,
    humidity: null,
    pressure: null,
    wind: 2,
    windGust: 4,
    windDirectionDegrees: 180,
    windDirection: "S",
    precipitation: 0,
    solarRadiation: null
  };
}

function localPayload() {
  return {
    ok: true,
    moena: {
      stazione: "Moena",
      quota: 1221,
      temperatura: 13.3,
      umidita: 73,
      pressione: 1021.4,
      dew_point: 8.5,
      wind_chill: 13.3,
      heat_index: 13.3,
      vento: 0,
      direzione: "N",
      vento_max_giorno: 18,
      pioggia: 0,
      pioggia_rate: 0,
      temperatura_min: 176,
      temperatura_max: 176,
      aggiornamento: updated,
      stato: "ok"
    },
    pezze: {
      stazione: "Frazione Pezzè - Moena",
      temperatura: 12.5,
      temperatura_min: 6.8,
      temperatura_max: 17.1,
      umidita: 75,
      dew_point: 8.2,
      heat_index: 12.4,
      pressione: 1022.1,
      vento: 3.2,
      raffica: 12.9,
      direzione: "NNW",
      pioggia_rate: 0,
      pioggia: 0,
      radiazione_solare: 350,
      uv: 2.1,
      aggiornamento: updated,
      stato: "ok"
    }
  };
}

function binding(payload, error = null) {
  return {
    async fetch() {
      if (error) throw error;
      return Response.json(payload);
    }
  };
}

async function get(path = "/", env = {}) {
  const response = await worker.fetch(new Request(`https://worker.test${path}`), env, {});
  return { response, body: await response.json() };
}

test("contratto delle stazioni principali di Moena", async t => {
  await t.test("normalizza T0096, Strada de Even e Frazione Pezzè", async () => {
    const env = {
      TRENTINO: binding(trentinoPayload()),
      POZZA: binding(localPayload())
    };
    const { response, body } = await get("/", env);

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.schemaVersion, "1.1");
    assert.equal(body.count, 3);
    assert.equal(body.online, 3);
    assert.deepEqual(body.stations.map(station => station.id), [
      "moena-diga-pezze",
      "moena-meteo",
      "moena-pezze-meteonetwork"
    ]);

    const official = body.stations[0];
    assert.equal(official.category, "official");
    assert.equal(official.temperature, 11.9);
    assert.equal(official.wind, 7.2);
    assert.equal(official.windGust, 14.4);
    assert.equal(official.latitude, 46.383644);

    const moena = body.stations[1];
    assert.equal(moena.temperature, 13.3);
    assert.equal(moena.temperatureMin, null);
    assert.equal(moena.temperatureMax, null);
    assert.match(moena.warnings.join(" "), /non plausibili/i);

    const pezze = body.stations[2];
    assert.equal(pezze.name, "Frazione Pezzè");
    assert.equal(pezze.altitude, 1212);
    assert.equal(pezze.temperatureMin, 6.8);
    assert.equal(pezze.windDirectionText, "NNW");
    assert.equal(pezze.solarRadiation, 350);
    assert.equal(pezze.uvIndex, 2.1);
  });

  await t.test("un guasto MeteoTrentino non blocca le stazioni locali", async () => {
    const env = {
      TRENTINO: binding(null, new Error("binding non disponibile")),
      POZZA: binding(localPayload())
    };
    const { body } = await get("/stations", env);

    assert.equal(body.partial, true);
    assert.equal(body.stations[0].status, "offline");
    assert.equal(body.stations[1].status, "online");
    assert.equal(body.stations[2].status, "online");
  });

  await t.test("health elenca i binding senza interrogarli", async () => {
    let calls = 0;
    const unused = { fetch: async () => { calls += 1; return Response.json({}); } };
    const { response, body } = await get("/health", {
      TRENTINO: unused,
      POZZA: unused
    });
    assert.equal(response.status, 200);
    assert.deepEqual(body.requiredBindings, ["TRENTINO", "POZZA"]);
    assert.equal(calls, 0);
  });

  await t.test("metodi ed endpoint non validi producono errori", async () => {
    const post = await worker.fetch(
      new Request("https://worker.test/", { method: "POST" }),
      {},
      {}
    );
    const missing = await get("/inesistente", {});
    assert.equal(post.status, 405);
    assert.equal(missing.response.status, 404);
  });
});
