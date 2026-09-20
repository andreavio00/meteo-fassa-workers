import test from "node:test";
import assert from "node:assert/strict";
import worker from "../meteopozza-amatoriali.js";

const nowEpoch = Math.floor(Date.now() / 1000) - 120;

function weatherCloudValues() {
  return {
    epoch: nowEpoch,
    temp: 12.4,
    hum: 67,
    dew: 6.4,
    chill: 12.1,
    heat: 12.4,
    bar: 1021.7,
    wspd: 1.5,
    wspdavg: 1.2,
    wspdhi: 2.5,
    wdir: 190,
    wdiravg: 185,
    rainrate: 0.2,
    rain: 3.4,
    solarrad: 410,
    uvi: 3
  };
}

function netatmoPayload(includeStation = true) {
  const station = {
    _id: "70:ee:50:17:9e:ba",
    place: {
      city: "Pozza di Fassa",
      altitude: 1325,
      location: [11.69, 46.43]
    },
    module_types: {
      "02:00:00:00:00:01": "NAModule1",
      "05:00:00:00:00:02": "NAModule2",
      "05:00:00:00:00:03": "NAModule3"
    },
    measures: {
      "70:ee:50:17:9e:ba": {
        type: ["pressure"],
        res: { [nowEpoch]: [1020.2] }
      },
      "02:00:00:00:00:01": {
        type: ["temperature", "humidity"],
        res: { [nowEpoch]: [11.8, 71] }
      },
      "05:00:00:00:00:02": {
        wind_strength: 7,
        gust_strength: 14,
        wind_angle: 220,
        wind_timeutc: nowEpoch
      },
      "05:00:00:00:00:03": {
        rain_live: 0.1,
        rain_60min: 0.4,
        rain_24h: 6.2,
        rain_timeutc: nowEpoch
      }
    }
  };
  return { body: includeStation ? [station] : [] };
}

function mockFetch(options = {}) {
  return async input => {
    const url = new URL(String(input));
    if (url.hostname === "app.weathercloud.net" && url.pathname.includes("/device/values/")) {
      if (options.failWeatherCloud) return new Response("errore", { status: 503 });
      return Response.json(weatherCloudValues());
    }
    if (url.hostname === "app.weathercloud.net" && url.pathname.startsWith("/d")) {
      return new Response(
        '<meta property="og:title" content="Stazione CEP - Weathercloud">' +
        '<div id="profile-altitude"><strong>15.0 m</strong></div>',
        { status: 200 }
      );
    }
    if (url.hostname === "auth.netatmo.com") {
      return Response.json({ body: "public-token" });
    }
    if (url.hostname === "app.netatmo.net") {
      return Response.json(netatmoPayload(!options.missingNetatmo));
    }
    throw new Error(`URL inatteso: ${url}`);
  };
}

async function get(path = "/") {
  const response = await worker.fetch(new Request(`https://worker.test${path}`), {}, {});
  return { response, body: await response.json() };
}

test("contratto delle stazioni amatoriali di Pozza", async t => {
  await t.test("normalizza entrambe le fonti", async () => {
    globalThis.fetch = mockFetch();
    const { response, body } = await get();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.stations.length, 2);
    assert.equal(body.online, 2);

    const weatherCloud = body.stations.find(station => station.id === "pozza-cep");
    assert.equal(weatherCloud.temperature, 12.4);
    assert.equal(weatherCloud.humidity, 67);
    assert.equal(weatherCloud.wind, 4.3);
    assert.equal(weatherCloud.windGust, 9);
    assert.equal(weatherCloud.altitude, null);
    assert.match(weatherCloud.warnings[0], /15 m/);

    const netatmo = body.stations.find(station => station.id === "pozza-netatmo");
    assert.equal(netatmo.temperature, 11.8);
    assert.equal(netatmo.pressure, 1020.2);
    assert.equal(netatmo.rainToday, 6.2);
    assert.equal(netatmo.windGust, 14);
    assert.equal(netatmo.altitude, 1325);
  });

  await t.test("un guasto WeatherCloud non blocca Netatmo", async () => {
    globalThis.fetch = mockFetch({ failWeatherCloud: true });
    const { response, body } = await get("/stations");

    assert.equal(response.status, 200);
    assert.equal(body.partial, true);
    assert.equal(body.stations[0].status, "offline");
    assert.equal(body.stations[1].status, "online");
  });

  await t.test("se l'ID Netatmo non compare, l'altra stazione resta disponibile", async () => {
    globalThis.fetch = mockFetch({ missingNetatmo: true });
    const { body } = await get();

    assert.equal(body.stations[0].status, "online");
    assert.equal(body.stations[1].status, "offline");
    assert.match(body.stations[1].error, /non trovata/i);
  });

  await t.test("health non interroga le fonti", async () => {
    globalThis.fetch = async () => { throw new Error("fetch non atteso"); };
    const { response, body } = await get("/health");
    assert.equal(response.status, 200);
    assert.equal(body.service, "meteopozza-amatoriali");
    assert.equal(body.stations.length, 2);
  });

  await t.test("metodi ed endpoint non validi producono errori", async () => {
    const post = await worker.fetch(new Request("https://worker.test/", { method: "POST" }), {}, {});
    const missing = await get("/inesistente");
    assert.equal(post.status, 405);
    assert.equal(missing.response.status, 404);
  });
});
