import test from "node:test";
import assert from "node:assert/strict";
import worker from "../meteomoena-previsioni.js";

function forecastPayload() {
  return {
    start: "2026-09-27T02:00:00",
    end: "2026-09-29T01:59:59",
    "180": {
      "1800": {
        temperature: 8,
        sky_condition: 2,
        rain_fall: 0,
        rain_probability: 10,
        wind_speed: 4,
        wind_gust: 8,
        wind_direction: 180
      },
      "180180": {
        temperature: 10,
        sky_condition: 3,
        rain_fall: 0.2,
        rain_probability: 30,
        wind_speed: 5,
        wind_gust: 10,
        wind_direction: 190
      }
    },
    "1440": {
      "14400": {
        temperature_minimum: 4,
        temperature_maximum: 14,
        sky_condition: 2,
        rain_fall: 0.2,
        rain_probability: 30,
        wind_speed: 5,
        wind_gust: 10,
        wind_direction: 190
      }
    }
  };
}

test("previsione fissa Meteo.report di Moena", async t => {
  await t.test("mantiene il formato delle previsioni di Pozza", async () => {
    globalThis.fetch = async () => Response.json(forecastPayload());
    const response = await worker.fetch(new Request("https://worker.test/"));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.source, "meteo.report");
    assert.equal(body.location.id, "moena");
    assert.equal(body.location.name, "Moena");
    assert.equal(body.location.source_id, "a35c1ca5-1a8a-4db2-89be-8fa4b5c0bee0");
    assert.equal(body.interval_minutes, 180);
    assert.equal(body.days[0].date, "2026-09-27");
    assert.equal(body.days[0].hours[0].time, "02:00");
    assert.equal(body.days[0].hours[1].time, "05:00");
  });

  await t.test("un errore della fonte restituisce 502 normalizzato", async () => {
    globalThis.fetch = async () => new Response("errore", { status: 503 });
    const response = await worker.fetch(new Request("https://worker.test/forecast"));
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.ok, false);
    assert.equal(body.location, "Moena");
  });

  await t.test("metodi ed endpoint non validi producono errori", async () => {
    const post = await worker.fetch(new Request("https://worker.test/", { method: "POST" }));
    const missing = await worker.fetch(new Request("https://worker.test/manca"));
    assert.equal(post.status, 405);
    assert.equal(missing.status, 404);
  });
});
