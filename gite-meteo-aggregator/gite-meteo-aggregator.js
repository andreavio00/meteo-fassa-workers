// ======================================================
// GITE METEO AGGREGATOR
// Versione 1.3
//
// Service Bindings richiesti:
// FASSA    -> gitemeteofassa
// TRENTINO -> gite-meteotrentino
// PREDAZZO -> gite-meteopredazzo-rodella
//
// /                   tutte le stazioni e le zone
// /status             controllo rapido di fonti e stazioni
// /zone/{id}          stazioni di una zona
// ?stations           elenco sintetico
// ======================================================


const SCHEMA_VERSION = "1.3";
const TIMEZONE = "Europe/Rome";
const CACHE_TTL_SECONDS = 120;
const UPSTREAM_TIMEOUT_MS = 4500;

const SAN_PELLEGRINO_STATION_URL =
  "https://www.meteonetwork.eu/it/weather-station/trn362-stazione-meteorologica-di-loc-alochet-sarcine-passo-san-pellegrino";


/*
  Pagine pubbliche delle fonti, pensate per il collegamento dalla UI.
  Non sono necessariamente gli endpoint tecnici usati dai Worker.
*/
const METEOTRENTINO_SOURCE_URL =
  "https://www.meteotrentino.it/dati/meteo/ultimi-dati-meteo/";

const STATION_SOURCE_URLS = {
  "fassa:gardeccia":
    "https://www.meteosystem.com/wlip/gardeccia/dati.php",
  "fassa:principe":
    "https://www.dolomitesmeteo.it/rosengartenpassoprincipe/",
  "fassa:sasspordoi":
    "https://www.dolomitesmeteo.it/sasspordoi/",
  "fassa:rolle":
    "https://www.primierometeo.it/passorolle/",
  "fassa:paradiso":
    "https://www.primierometeo.it/paradiso/",
  "fassa:sarcine":
    SAN_PELLEGRINO_STATION_URL,
  "fassa:passosella":
    "https://www.dolomitesmeteo.it/passosella/tabella.html",
  "fassa:pizboe":
    "https://www.dolomitesmeteo.it/pizboe/",
  "fassa:coldeirossi":
    "https://www.dolomitesmeteo.it/coldeirossi/tabella.php",

  "trentino:moena": METEOTRENTINO_SOURCE_URL,
  "trentino:gries": METEOTRENTINO_SOURCE_URL,
  "trentino:costalunga": METEOTRENTINO_SOURCE_URL,
  "trentino:campitello": METEOTRENTINO_SOURCE_URL,
  "trentino:fedaia": METEOTRENTINO_SOURCE_URL,
  "trentino:ciampac": METEOTRENTINO_SOURCE_URL,
  "trentino:sasdelmul": METEOTRENTINO_SOURCE_URL,

  "predazzo:colrodella":
    "https://icarusfassa.it/stazione-meteo-icarus-flying-team/",
  "predazzo:gardone":
    "https://www.meteo-predazzo.it/gardone-1650-m-slm/",
  "predazzo:passofeudo":
    "https://www.meteo-predazzo.it/passo-feudo-2200-m-slm/",
  "predazzo:torredipisa":
    "https://www.meteo-predazzo.it/rifugio-torre-di-pisa-2671-m-slm/"
};


/*
  Le associazioni geografiche vivono nell'aggregatore centrale.
  I Worker sorgente continuano a occuparsi soltanto della raccolta dati.

  L'ordine delle chiavi e' anche l'ordine di presentazione consigliato.
  Una stazione puo' appartenere a piu' zone.
*/
const ZONES = [
  {
    id: "catinaccio",
    name: "Catinaccio",
    stationKeys: [
      "fassa:gardeccia",
      "fassa:principe",
      "trentino:costalunga",
      "trentino:campitello"
    ]
  },
  {
    id: "sassolungo_sella",
    name: "Sella e Sassolungo",
    stationKeys: [
      "fassa:passosella",
      "fassa:sasspordoi",
      "fassa:pizboe",
      "fassa:coldeirossi",
      "predazzo:colrodella"
    ]
  },
  {
    id: "marmolada_val_s_nicolo",
    name: "Marmolada e Val San Nicolò",
    stationKeys: [
      "trentino:sasdelmul",
      "trentino:ciampac",
      "trentino:fedaia",
      "fassa:coldeirossi"
    ]
  },
  {
    id: "moena_latemar",
    name: "Moena e Latemar",
    stationKeys: [
      "fassa:sarcine",
      "fassa:rolle",
      "predazzo:torredipisa",
      "predazzo:passofeudo",
      "predazzo:gardone"
    ]
  }
];


const ZONE_ALIASES = {
  sella: "sassolungo_sella",
  sella_sassolungo: "sassolungo_sella",
  marmolada: "marmolada_val_s_nicolo",
  moena: "moena_latemar"
};


const STATION_ZONES = new Map();

for (const zone of ZONES) {
  for (const key of zone.stationKeys) {
    const zoneIds = STATION_ZONES.get(key) || [];
    zoneIds.push(zone.id);
    STATION_ZONES.set(key, zoneIds);
  }
}


// ======================================================
// HEADERS
// ======================================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}


function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
        ...corsHeaders()
      }
    }
  );
}


// ======================================================
// NUMERI
// ======================================================

function num(value) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  )
    return null;

  if (typeof value === "number")
    return value;

  const cleaned =
    String(value)
      .replace(" m", "")
      .replace(",", ".")
      .trim();

  const n = Number(cleaned);

  return Number.isFinite(n)
    ? n
    : null;
}


// ======================================================
// DIREZIONE VENTO
// ======================================================

function directionFromDegrees(value) {

  const deg = num(value);

  if (deg === null)
    return null;

  const dirs = [
    "N", "NNE", "NE", "ENE",
    "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW",
    "W", "WNW", "NW", "NNW"
  ];

  const normalized =
    ((deg % 360) + 360) % 360;

  return dirs[
    Math.round(normalized / 22.5) % 16
  ];
}


// ======================================================
// NORMALIZZAZIONE
// ======================================================

function normalize(station, family) {

  const s = station || {};
  const stationKey = `${family}:${s.id}`;
  const zones = [
    ...(STATION_ZONES.get(stationKey) || [])
  ];


  // --------------------------
  // VENTO
  // --------------------------

  let wind =
    num(s.wind);

  let windGust =
    num(
      s.windGust ??
      s.gust
    );

  let windMax =
    num(s.windMax);


  /*
    MeteoTrentino restituisce vento in m/s.

    Fassa e Predazzo/Rodella
    vengono mantenuti in km/h.
  */

  if (family === "trentino") {

    if (wind !== null)
      wind =
        +(wind * 3.6)
          .toFixed(1);

    if (windGust !== null)
      windGust =
        +(windGust * 3.6)
          .toFixed(1);

    if (windMax !== null)
      windMax =
        +(windMax * 3.6)
          .toFixed(1);
  }


  const windDegrees =
    num(
      s.windDirectionDegrees
    );


  // --------------------------
  // TEMPERATURA
  // --------------------------

  const temperatureMin =
    num(
      s.temperatureMin ??
      s.temperatureLow
    );

  const temperatureMax =
    num(
      s.temperatureMax ??
      s.temperatureHigh
    );


  // --------------------------
  // RISPOSTA COMUNE
  // --------------------------

  return {

    // Identificazione

    id:
      s.id || null,

    key:
      stationKey,

    name:
      s.name || s.id || null,

    zones,

    primary_zone:
      zones[0] || null,

    altitude:
      num(s.altitude),

    latitude:
      num(s.latitude),

    longitude:
      num(s.longitude),

    family,

    source:
      s.source || family,

    sourceUrl:
      s.sourceUrl ||
      s.url ||
      STATION_SOURCE_URLS[stationKey] ||
      null,

    status:
      s.status || "unknown",


    // --------------------------
    // AGGIORNAMENTO
    // --------------------------

    updated:
      s.updated || null,

    updatedText:
      s.updatedText || null,

    fetchedAt:
      s.fetchedAt || null,


    // --------------------------
    // TEMPERATURA
    // --------------------------

    temperature:
      num(s.temperature),

    temperatureAt:
      s.temperatureAt || null,

    temperatureMin,

    temperatureMinAt:
      s.temperatureMinAt || null,

    temperatureMax,

    temperatureMaxAt:
      s.temperatureMaxAt || null,

    temperatureLowTime:
      s.temperatureLowTime || null,

    temperatureHighTime:
      s.temperatureHighTime || null,


    // --------------------------
    // PERCEPITA
    // --------------------------

    feelsLike:
      num(
        s.feelsLike ??
        s.perceived
      ),

    heatIndex:
      num(s.heatIndex),

    windChill:
      num(s.windChill),

    dewPoint:
      num(s.dewPoint),


    // --------------------------
    // UMIDITÀ
    // --------------------------

    humidity:
      num(s.humidity),

    humidityAt:
      s.humidityAt || null,

    humidityLow:
      num(s.humidityLow),

    humidityHigh:
      num(s.humidityHigh),


    // --------------------------
    // PRESSIONE
    // --------------------------

    pressure:
      num(s.pressure),

    pressureAt:
      s.pressureAt || null,

    pressureLow:
      num(s.pressureLow),

    pressureHigh:
      num(s.pressureHigh),


    // --------------------------
    // VENTO
    // sempre km/h
    // --------------------------

    wind,

    windAt:
      s.windAt || null,

    windGust,

    windGustAt:
      s.windGustAt || null,

    windMax,

    windDirection:
      s.windDirection ||
      directionFromDegrees(
        windDegrees
      ),

    windDirectionDegrees:
      windDegrees,

    windDirectionAt:
      s.windDirectionAt || null,


    // --------------------------
    // PIOGGIA
    // --------------------------

    precipitation:
      num(s.precipitation),

    precipitationAt:
      s.precipitationAt || null,

    rainRate:
      num(s.rainRate),

    rainToday:
      num(s.rainToday),

    rainMonth:
      num(s.rainMonth),

    rainTotal:
      num(s.rainTotal),


    // --------------------------
    // ALTRI SENSORI
    // --------------------------

    solarRadiation:
      num(s.solarRadiation),

    solarRadiationAt:
      s.solarRadiationAt || null,

    snowHeight:
      num(s.snowHeight),

    snowHeightAt:
      s.snowHeightAt || null,

    uv:
      num(s.uv),


    // --------------------------
    // UNITÀ NORMALIZZATE
    // --------------------------

    units: {
      temperature: "°C",
      feelsLike: "°C",
      dewPoint: "°C",
      humidity: "%",
      pressure: "hPa",
      wind: "km/h",
      windGust: "km/h",
      windMax: "km/h",
      windDirectionDegrees: "°",
      precipitation: "mm",
      rain: "mm",
      rainRate: "mm/h",
      solarRadiation: "W/m²",
      snowHeight: "cm",
      uv: "index"
    },


    // --------------------------
    // DATI ORIGINALI
    // --------------------------

    original: s
  };
}


// ======================================================
// PASSO SAN PELLEGRINO - METEONETWORK TRN362
// ======================================================

/*
  TRN362 si trova in localita' Alochet/Sarcine, nel settore del Passo San
  Pellegrino. La leggiamo qui in parallelo ai tre Worker sorgente: in questo
  modo Cima Paradiso (che appartiene al Passo Rolle) non viene piu' usata come
  riferimento geografico del San Pellegrino.

  La stazione puo' risultare temporaneamente offline. In quel caso manteniamo
  comunque la sua identita' nella zona, senza trasformare dati vecchi in una
  falsa osservazione corrente; quando MeteoNetwork torna online il parser
  riprende automaticamente a esporre i valori.
*/

function meteoNetworkText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&deg;|&#176;/gi, "°")
    .replace(/&minus;|&#8722;/gi, "-")
    .replace(/\s+/g, " ")
    .trim();
}


function matchedNumber(match, index = 1) {
  return match ? num(match[index]) : null;
}


function meteoNetworkUpdated(html) {
  const hour = html.match(
    /let\s+maxTHour\s*=\s*(\d{1,2})\s*-\s*hours/
  );
  const minute = html.match(
    /let\s+maxTMin\s*=\s*(\d{1,2})\s*-\s*parseInt\(minutes\)/
  );
  const date = html.match(
    /'\s*del\s*'\s*\+\s*'(\d{4}-\d{2}-\d{2})'/
  );

  if (!hour || !minute || !date)
    return null;

  const hh = String(hour[1]).padStart(2, "0");
  const mm = String(minute[1]).padStart(2, "0");
  return `${date[1]}T${hh}:${mm}:00Z`;
}


function parseSanPellegrinoStation(html) {
  const text = meteoNetworkText(html);
  const fetchedAt = new Date().toISOString();

  const temperatureValues = text.match(
    /Temperatura\s+(-?\d+(?:[.,]\d+)?)\s*°C\s+(-?\d+(?:[.,]\d+)?)\s*°C\s+(-?\d+(?:[.,]\d+)?)\s*°C/i
  );

  const temperature = temperatureValues
    ? matchedNumber(temperatureValues, 1)
    : matchedNumber(text.match(
      /Temperatura\s+(-?\d+(?:[.,]\d+)?)\s*°C/i
    ));

  const sourceOnline = /class="btn btn-success"[^>]*>\s*online\s*</i.test(html);

  return {
    id: "sarcine",
    name: "Sarcine - Passo San Pellegrino",
    altitude: 1800,
    latitude: 46.376913,
    longitude: 11.751399,
    source: "MeteoNetwork",
    sourceUrl: SAN_PELLEGRINO_STATION_URL,
    status: sourceOnline && temperature !== null ? "online" : "offline",
    updated: meteoNetworkUpdated(html),
    fetchedAt,
    temperature,
    temperatureMax: temperatureValues
      ? matchedNumber(temperatureValues, 2)
      : null,
    temperatureMin: temperatureValues
      ? matchedNumber(temperatureValues, 3)
      : null,
    humidity: matchedNumber(text.match(
      /Umidit(?:a|à)\s+(\d+(?:[.,]\d+)?)\s*%/i
    )),
    pressure: matchedNumber(text.match(
      /Pressione\s+(\d+(?:[.,]\d+)?)\s*hPa/i
    )),
    precipitation: matchedNumber(text.match(
      /Pioggia\s+(\d+(?:[.,]\d+)?)\s*mm/i
    )),
    rainRate: matchedNumber(text.match(
      /Pioggia\s+\d+(?:[.,]\d+)?\s*mm\s*\(\s*(\d+(?:[.,]\d+)?)\s*mm\/h/i
    )),
    wind: matchedNumber(text.match(
      /Vento\s+(\d+(?:[.,]\d+)?)\s*km\/h/i
    )),
    windDirection: text.match(
      /Vento\s+\d+(?:[.,]\d+)?\s*km\/h\s*\(([^)]+)\)/i
    )?.[1]?.trim() || null,
    windGust: matchedNumber(text.match(
      /Raffica\s+(\d+(?:[.,]\d+)?)\s*km\/h/i
    )),
    dewPoint: matchedNumber(text.match(
      /Temp\.\s*di\s*rugiada\s+(-?\d+(?:[.,]\d+)?)\s*°C/i
    )),
    stationCode: "TRN362"
  };
}


function unavailableSanPellegrinoStation(error) {
  return {
    id: "sarcine",
    name: "Sarcine - Passo San Pellegrino",
    altitude: 1800,
    latitude: 46.376913,
    longitude: 11.751399,
    source: "MeteoNetwork",
    sourceUrl: SAN_PELLEGRINO_STATION_URL,
    status: "error",
    updated: null,
    fetchedAt: new Date().toISOString(),
    stationCode: "TRN362",
    error: String(error?.message || error || "Fonte non disponibile")
  };
}


async function fetchSanPellegrinoStation() {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    UPSTREAM_TIMEOUT_MS
  );

  try {
    const response = await fetch(
      SAN_PELLEGRINO_STATION_URL,
      {
        headers: {
          "Accept": "text/html,application/xhtml+xml",
          "User-Agent": "Mozilla/5.0 (compatible; MeteoFassaWorker/1.3)"
        },
        signal: controller.signal,
        cf: {
          cacheEverything: true,
          cacheTtl: CACHE_TTL_SECONDS
        }
      }
    );

    if (!response.ok)
      throw new Error(`MeteoNetwork HTTP ${response.status}`);

    return parseSanPellegrinoStation(
      await response.text()
    );
  } catch (error) {
    return unavailableSanPellegrinoStation(error);
  } finally {
    clearTimeout(timer);
  }
}


// ======================================================
// LETTURA SERVICE BINDING
// ======================================================

async function fetchService(
  id,
  binding
) {

  try {

    const response =
      await binding.fetch(
        new Request(
          "https://internal/"
        )
      );


    if (!response.ok)
      throw new Error(
        `HTTP ${response.status}`
      );


    const data =
      await response.json();


    const stations =
      Array.isArray(
        data?.stations
      )
        ? data.stations
        : [];


    return {

      id,

      status:
        "online",

      version:
        data.version || null,

      generatedAt:
        data.generatedAt || null,

      count:
        stations.length,

      stations
    };


  } catch (err) {

    return {

      id,

      status:
        "error",

      version:
        null,

      generatedAt:
        null,

      count:
        0,

      stations:
        [],

      error:
        String(
          err?.message ||
          err
        )
    };
  }
}


// ======================================================
// ZONE E RIEPILOGO
// ======================================================

function stationSummary(station) {
  return {
    id: station.id,
    key: station.key,
    name: station.name,
    altitude: station.altitude,
    family: station.family,
    source: station.source,
    sourceUrl: station.sourceUrl,
    status: station.status,
    zones: station.zones,
    primary_zone: station.primary_zone,
    updated: station.updated,
    updatedText: station.updatedText,
    fetchedAt: station.fetchedAt
  };
}


function buildZone(zone, stations) {
  const stationByKey = new Map(
    stations.map(station => [station.key, station])
  );

  const zoneStations = zone.stationKeys
    .map(key => stationByKey.get(key))
    .filter(Boolean);

  const missingStationKeys = zone.stationKeys
    .filter(key => !stationByKey.has(key));

  return {
    id: zone.id,
    name: zone.name,
    expected_station_count: zone.stationKeys.length,
    station_count: zoneStations.length,
    missing_station_keys: missingStationKeys,
    stations: zoneStations
  };
}


function buildZones(stations) {
  return ZONES.map(zone => buildZone(zone, stations));
}


function resolveZone(rawId) {
  let requestedId;

  try {
    requestedId = decodeURIComponent(
      String(rawId || "")
    ).toLowerCase();
  } catch {
    return null;
  }

  const zoneId = ZONE_ALIASES[requestedId] || requestedId;
  return ZONES.find(zone => zone.id === zoneId) || null;
}


function buildOverview(stations, results) {
  const onlineStations = stations.filter(
    station => station.status === "online"
  ).length;

  const families = {};

  for (const result of results) {
    const familyStations = stations.filter(
      station => station.family === result.id
    );

    families[result.id] = {
      total: familyStations.length,
      online: familyStations.filter(
        station => station.status === "online"
      ).length,
      offline: familyStations.filter(
        station => station.status !== "online"
      ).length,
      source_status: result.status
    };
  }

  return {
    total_stations: stations.length,
    online_stations: onlineStations,
    offline_stations: stations.length - onlineStations,
    all_online:
      results.every(result => result.status === "online") &&
      onlineStations === stations.length,
    families,
    unassigned_stations: stations
      .filter(station => station.zones.length === 0)
      .map(stationSummary),
    stations: stations.map(stationSummary)
  };
}


// ======================================================
// WORKER
// ======================================================

export default {

  async fetch(request, env) {


    // --------------------------
    // CORS
    // --------------------------

    if (
      request.method ===
      "OPTIONS"
    ) {

      return new Response(
        null,
        {
          status: 204,
          headers:
            corsHeaders()
        }
      );
    }


    const url =
      new URL(request.url);

    const pathname =
      url.pathname.replace(/\/+$/, "") || "/";


    if (request.method !== "GET") {
      return json(
        {
          error: "Metodo non consentito"
        },
        405
      );
    }


    // ==================================================
    // CARICA LE TRE FAMIGLIE IN PARALLELO
    // ==================================================

    const [results, sanPellegrinoStation] =
      await Promise.all([

        Promise.all([

          fetchService(
            "fassa",
            env.FASSA
          ),

          fetchService(
            "trentino",
            env.TRENTINO
          ),

          fetchService(
            "predazzo",
            env.PREDAZZO
          )

        ]),

        fetchSanPellegrinoStation()

      ]);


    const fassaResult =
      results.find(result => result.id === "fassa");

    if (
      fassaResult &&
      !fassaResult.stations.some(station => station?.id === "sarcine")
    ) {
      fassaResult.stations.push(sanPellegrinoStation);
      fassaResult.count = fassaResult.stations.length;
    }


    // ==================================================
    // NORMALIZZA
    // ==================================================

    const stations = [];


    for (
      const result
      of results
    ) {

      for (
        const station
        of result.stations
      ) {

        stations.push(
          normalize(
            station,
            result.id
          )
        );
      }
    }


    const generatedAt =
      new Date().toISOString();

    const sources =
      results.map(
        result => ({
          id: result.id,
          status: result.status,
          version: result.version,
          generated_at: result.generatedAt,
          generatedAt: result.generatedAt,
          count: result.count,
          error: result.error || null
        })
      );

    const zones =
      buildZones(stations);

    const overview =
      buildOverview(stations, results);


    // ==================================================
    // /status
    // ==================================================

    if (pathname === "/status") {
      return json({
        schema_version: SCHEMA_VERSION,
        generated_at: generatedAt,
        timezone: TIMEZONE,
        overview,
        sources
      });
    }


    // ==================================================
    // /zone/{id}
    // ==================================================

    const zoneMatch =
      pathname.match(/^\/zone\/([^/]+)$/);

    if (zoneMatch) {
      const zone = resolveZone(zoneMatch[1]);

      if (!zone) {
        return json(
          {
            schema_version: SCHEMA_VERSION,
            generated_at: generatedAt,
            error: "Zona non trovata",
            available_zones: ZONES.map(item => item.id)
          },
          404
        );
      }

      return json({
        schema_version: SCHEMA_VERSION,
        generated_at: generatedAt,
        timezone: TIMEZONE,
        zone: buildZone(zone, stations)
      });
    }


    // ==================================================
    // ?stations
    // VERSIONE LEGGERA
    // ==================================================

    if (
      pathname === "/stations" ||
      url.searchParams.has("stations")
    ) {

      return json({

        schema_version:
          SCHEMA_VERSION,

        generated_at:
          generatedAt,

        timezone:
          TIMEZONE,

        version:
          SCHEMA_VERSION,

        generatedAt:
          generatedAt,

        count:
          stations.length,

        stations:
          stations.map(stationSummary)
      });
    }


    // ==================================================
    // RISPOSTA COMPLETA
    // ==================================================

    return json({

      schema_version:
        SCHEMA_VERSION,

      generated_at:
        generatedAt,

      timezone:
        TIMEZONE,

      cache_ttl_seconds:
        CACHE_TTL_SECONDS,

      overview,

      total_unique_stations:
        stations.length,

      total_zones:
        zones.length,

      zones,

      version:
        SCHEMA_VERSION,

      generatedAt:
        generatedAt,

      count:
        stations.length,


      // Stato dei tre Worker sorgente

      sources:
        sources,


      // Tutte le stazioni

      stations
    });
  }
};
