/*
 * gite-previsioni-aggregator v1.2
 *
 * Service Bindings:
 *   env.METEOREPORT -> gite-previsioni-meteoreport
 *   env.OPENMETEO   -> gite-previsioni-open-meteo
 *
 * Endpoint:
 *   /
 *   /forecast
 *   /gite-previsioni.json
 *   /status
 *   /location/:id
 *   /zone/:id
 *   /raw/meteoreport
 *   /raw/openmeteo
 *   /raw/meteoreport/:id
 *   /raw/openmeteo/:id
 */

const CACHE_TTL = 30 * 60;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8"
};


/* =========================================================
   ZONE
   ========================================================= */

const ZONES = [
  {
    id: "catinaccio",
    name: "Catinaccio"
  },
  {
    id: "sassolungo_sella",
    name: "Sassolungo - Sella"
  },
  {
    id: "marmolada_val_s_nicolo",
    name: "Marmolada - Val S. Nicolò"
  },
  {
    id: "moena_latemar",
    name: "Moena - Latemar"
  }
];


const LOCATION_ZONES = {

  "passo_costalunga": [
    "catinaccio",
    "moena_latemar"
  ],

  "passo_nigra": [
    "catinaccio"
  ],

  "passo_sella": [
    "sassolungo_sella"
  ],

  "passo_pordoi": [
    "sassolungo_sella"
  ],

  "passo_san_pellegrino": [
    "marmolada_val_s_nicolo",
    "moena_latemar"
  ],

  "passo_rolle": [
    "moena_latemar"
  ],

  "baita_alle_cascate": [
    "marmolada_val_s_nicolo"
  ],

  "passo_san_nicolo": [
    "marmolada_val_s_nicolo"
  ],

  "rifugio_contrin": [
    "marmolada_val_s_nicolo"
  ],

  "penia": [
    "marmolada_val_s_nicolo"
  ],

  "passo_fedaia": [
    "marmolada_val_s_nicolo"
  ],

  "rifugio_vajolet": [
    "catinaccio"
  ],

  "fuciade": [
    "moena_latemar"
  ],

  "passo_feudo": [
    "moena_latemar"
  ],

  "rifugio_sasso_piatto": [
    "sassolungo_sella"
  ],

  "val_duron_baita_lino_brach": [
    "catinaccio",
    "sassolungo_sella"
  ]
};


/* =========================================================
   NUMERIC HELPERS
   ========================================================= */

function validNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const n = Number(value);

  return Number.isFinite(n) ? n : null;
}


function validValues(values) {
  return values
    .map(validNumber)
    .filter(v => v !== null);
}


function average(values) {
  const vals = validValues(values);

  if (!vals.length) return null;

  return vals.reduce((a, b) => a + b, 0) / vals.length;
}


function sum(values) {
  const vals = validValues(values);

  if (!vals.length) return null;

  return vals.reduce((a, b) => a + b, 0);
}


function minimum(values) {
  const vals = validValues(values);

  return vals.length
    ? Math.min(...vals)
    : null;
}


function maximum(values) {
  const vals = validValues(values);

  return vals.length
    ? Math.max(...vals)
    : null;
}


function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;

  const factor = 10 ** digits;

  return Math.round(value * factor) / factor;
}


/* =========================================================
   DATE HELPERS
   ========================================================= */

function parseLocalIso(iso) {
  const match = String(iso).match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/
  );

  if (!match) return null;

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5])
  };
}


function addMinutesLocal(iso, minutes) {
  const p = parseLocalIso(iso);

  if (!p) return null;

  const date = new Date(Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute
  ));

  date.setUTCMinutes(
    date.getUTCMinutes() + minutes
  );

  return date
    .toISOString()
    .slice(0, 16);
}


/* =========================================================
   WEATHER NORMALIZZATO
   ========================================================= */

const WEATHER = {

  clear: {
    code: "clear",
    label_it: "Sereno",
    icon: "☀️",
    severity: 10
  },

  mostly_clear: {
    code: "mostly_clear",
    label_it: "Poco nuvoloso",
    icon: "🌤️",
    severity: 20
  },

  partly_cloudy: {
    code: "partly_cloudy",
    label_it: "Parzialmente nuvoloso",
    icon: "⛅",
    severity: 30
  },

  cloudy: {
    code: "cloudy",
    label_it: "Nuvoloso",
    icon: "☁️",
    severity: 40
  },

  fog: {
    code: "fog",
    label_it: "Nebbia",
    icon: "🌫️",
    severity: 50
  },

  drizzle: {
    code: "drizzle",
    label_it: "Pioviggine",
    icon: "🌦️",
    severity: 60
  },

  rain: {
    code: "rain",
    label_it: "Pioggia",
    icon: "🌧️",
    severity: 70
  },

  snow: {
    code: "snow",
    label_it: "Neve",
    icon: "🌨️",
    severity: 80
  },

  showers: {
    code: "showers",
    label_it: "Rovesci",
    icon: "🌦️",
    severity: 90
  },

  thunderstorm: {
    code: "thunderstorm",
    label_it: "Temporale",
    icon: "⛈️",
    severity: 110
  },

  unknown: {
    code: "unknown",
    label_it: "Non definito",
    icon: "❔",
    severity: 0
  }
};


function makeWeather(type, sourceCode = null) {
  const base =
    WEATHER[type] || WEATHER.unknown;

  return {
    ...base,
    source_code: sourceCode
  };
}


/* =========================================================
   OPEN-METEO WMO
   ========================================================= */

const WMO_PRIORITY = {
  0: 10,
  1: 20,
  2: 30,
  3: 40,

  45: 50,
  48: 55,

  51: 60,
  53: 62,
  55: 64,
  56: 66,
  57: 68,

  61: 70,
  63: 72,
  65: 74,
  66: 76,
  67: 78,

  71: 80,
  73: 82,
  75: 84,
  77: 86,

  80: 90,
  81: 92,
  82: 94,

  85: 96,
  86: 98,

  95: 110,
  96: 115,
  99: 120
};


function representativeWmo(codes) {
  const valid = validValues(codes);

  if (!valid.length) return null;

  return valid.reduce((best, current) => {

    const bestPriority =
      WMO_PRIORITY[best] ?? -1;

    const currentPriority =
      WMO_PRIORITY[current] ?? -1;

    return currentPriority > bestPriority
      ? current
      : best;
  });
}


function weatherFromWmo(code) {

  if (code === null) {
    return makeWeather("unknown", null);
  }

  if (code === 0)
    return makeWeather("clear", code);

  if (code === 1)
    return makeWeather("mostly_clear", code);

  if (code === 2)
    return makeWeather("partly_cloudy", code);

  if (code === 3)
    return makeWeather("cloudy", code);

  if ([45, 48].includes(code))
    return makeWeather("fog", code);

  if ([51,53,55,56,57].includes(code))
    return makeWeather("drizzle", code);

  if ([61,63,65,66,67].includes(code))
    return makeWeather("rain", code);

  if ([71,73,75,77,85,86].includes(code))
    return makeWeather("snow", code);

  if ([80,81,82].includes(code))
    return makeWeather("showers", code);

  if ([95,96,99].includes(code))
    return makeWeather("thunderstorm", code);

  return makeWeather("unknown", code);
}


/* =========================================================
   METEO.REPORT WEATHER
   ========================================================= */

function weatherFromMeteoReport(record) {

  const freshSnow =
    validNumber(record.fresh_snow);

  const rain =
    validNumber(record.rain_fall);

  const sky =
    record.sky_condition ?? null;


  if (
    freshSnow !== null &&
    freshSnow > 0
  ) {
    return makeWeather("snow", sky);
  }


  if (
    rain !== null &&
    rain > 0
  ) {
    return makeWeather("rain", sky);
  }


  if (sky === "A") {
    return makeWeather("clear", sky);
  }


  if (sky === "B") {
    return makeWeather(
      "partly_cloudy",
      sky
    );
  }


  return makeWeather(
    "unknown",
    sky
  );
}


/* =========================================================
   WIND
   ========================================================= */

function weightedWindDirection(
  directions,
  speeds
) {

  let x = 0;
  let y = 0;
  let totalWeight = 0;


  for (let i = 0; i < directions.length; i++) {

    const direction =
      validNumber(directions[i]);

    const speed =
      validNumber(speeds[i]);


    if (
      direction === null ||
      speed === null
    ) continue;


    const radians =
      direction * Math.PI / 180;


    x += Math.sin(radians) * speed;
    y += Math.cos(radians) * speed;

    totalWeight += speed;
  }


  if (!totalWeight) return null;


  let degrees =
    Math.atan2(x, y) *
    180 / Math.PI;


  if (degrees < 0) {
    degrees += 360;
  }


  return round(degrees, 0);
}


/* =========================================================
   OPEN-METEO PERIOD
   ========================================================= */

function normalizeOpenMeteoPeriod(period) {

  const hours =
    Array.isArray(period.source_hours)
      ? period.source_hours
      : [];


  const validHours =
    hours.filter(hour =>
      hour.temperature_2m !== null ||
      hour.precipitation !== null ||
      hour.weather_code !== null ||
      hour.wind_speed_10m !== null
    );


  if (!validHours.length) {
    return null;
  }


  const temperatures =
    validHours.map(h => h.temperature_2m);

  const rain =
    validHours.map(h => h.precipitation);

  const rainProbability =
    validHours.map(h => h.precipitation_probability);

  const weatherCodes =
    validHours.map(h => h.weather_code);

  const windSpeed =
    validHours.map(h => h.wind_speed_10m);

  const gusts =
    validHours.map(h => h.wind_gusts_10m);

  const windDirection =
    validHours.map(h => h.wind_direction_10m);


  const representativeCode =
    representativeWmo(weatherCodes);


  return {

    start: period.start,
    end: period.end,
    date: period.date,
    period: period.period,


    summary: {

      weather:
        weatherFromWmo(
          representativeCode
        ),

      temperature_c:
        round(
          average(temperatures),
          1
        ),

      precipitation_mm:
        round(
          sum(rain),
          1
        ),

      precipitation_probability_pct:
        maximum(
          rainProbability
        )
    },


    details: {

      temperature_min_c:
        round(
          minimum(temperatures),
          1
        ),

      temperature_max_c:
        round(
          maximum(temperatures),
          1
        ),

      wind_speed_avg_kmh:
        round(
          average(windSpeed),
          1
        ),

      wind_speed_max_kmh:
        round(
          maximum(windSpeed),
          1
        ),

      wind_gust_max_kmh:
        round(
          maximum(gusts),
          1
        ),

      wind_direction_deg:
        weightedWindDirection(
          windDirection,
          windSpeed
        ),

      weather_codes_hourly:
        weatherCodes,

      source_hours:
        hours
    },


    source: {
      provider: "open-meteo",
      model: "icon_d2",
      weather_code:
        representativeCode
    }
  };
}


/* =========================================================
   OPEN-METEO LOCATION
   ========================================================= */

function normalizeOpenMeteoLocation(location) {

  const periods =
    (location.summary_3h || [])
      .map(
        normalizeOpenMeteoPeriod
      )
      .filter(Boolean);


  return {

    id: location.id,
    name: location.name,

    provider: "open-meteo",
    model: "icon_d2",

    zones:
      LOCATION_ZONES[
        location.id
      ] || [],

    primary_zone:
      LOCATION_ZONES[
        location.id
      ]?.[0] ?? null,

    coordinates: {

      latitude:
        location
          .requested_coordinates
          ?.latitude ?? null,

      longitude:
        location
          .requested_coordinates
          ?.longitude ?? null
    },


    model_point: {

      latitude:
        location
          .open_meteo_coordinates
          ?.latitude ?? null,

      longitude:
        location
          .open_meteo_coordinates
          ?.longitude ?? null,

      elevation_m:
        location
          .open_meteo_coordinates
          ?.elevation_m ?? null
    },


    timezone:
      location.timezone ?? null,

    periods_3h:
      periods
  };
}


/* =========================================================
   METEO.REPORT PERIOD
   ========================================================= */

function normalizeMeteoReportPeriod(
  key,
  record,
  start
) {

  const offsetText =
    String(key).slice(3);

  const offsetMinutes =
    Number(offsetText);


  if (
    !Number.isFinite(
      offsetMinutes
    )
  ) {
    return null;
  }


  const periodStart =
    addMinutesLocal(
      start,
      offsetMinutes
    );


  const periodEnd =
    addMinutesLocal(
      periodStart,
      180
    );


  if (
    !periodStart ||
    !periodEnd
  ) {
    return null;
  }


  return {

    start: periodStart,
    end: periodEnd,

    date:
      periodStart.slice(0, 10),

    period:
      `${periodStart.slice(11,16)}-${periodEnd.slice(11,16)}`,


    summary: {

      weather:
        weatherFromMeteoReport(
          record
        ),

      temperature_c:
        validNumber(
          record.temperature
        ),

      precipitation_mm:
        validNumber(
          record.rain_fall
        ),

      precipitation_probability_pct:
        validNumber(
          record.rain_probability
        )
    },


    details: {

      wind_speed_kmh:
        validNumber(
          record.wind_speed
        ),

      wind_gust_kmh:
        validNumber(
          record.wind_gust
        ),

      wind_direction_deg:
        validNumber(
          record.wind_direction
        ),

      fresh_snow:
        validNumber(
          record.fresh_snow
        ),

      snow_level_m:
        validNumber(
          record.snow_level
        ),

      freezing_level_m:
        validNumber(
          record.freezing_level
        ),

      sunshine_duration:
        validNumber(
          record.sunshine_duration
        ),

      sky_condition:
        record.sky_condition ?? null
    },


    source: {

      provider:
        "meteo.report",

      source_key:
        key,

      sky_condition:
        record.sky_condition ?? null
    }
  };
}


/* =========================================================
   METEO.REPORT LOCATION
   ========================================================= */

function normalizeMeteoReportLocation(location) {

  const forecast =
    location.forecast_180 || {};


  const periods =
    Object.entries(forecast)

      .map(
        ([key, record]) =>
          normalizeMeteoReportPeriod(
            key,
            record,
            location.start
          )
      )

      .filter(Boolean)

      .sort(
        (a, b) =>
          a.start.localeCompare(
            b.start
          )
      );


  return {

    id: location.id,
    name: location.name,

    provider:
      "meteo.report",

    model: null,

    zones:
      LOCATION_ZONES[
        location.id
      ] || [],

    primary_zone:
      LOCATION_ZONES[
        location.id
      ]?.[0] ?? null,

    source_id:
      location.source_id ?? null,

    forecast_start:
      location.start ?? null,

    forecast_end:
      location.end ?? null,

    interval_minutes:
      location.interval_minutes ?? 180,

    periods_3h:
      periods
  };
}


/* =========================================================
   DAYS
   ========================================================= */

function groupPeriodsByDay(periods) {

  const map = new Map();


  for (const period of periods) {

    if (!map.has(period.date)) {
      map.set(period.date, []);
    }

    map
      .get(period.date)
      .push(period);
  }


  return Array.from(
    map.entries()
  )

    .map(
      ([date, periods_3h]) => ({
        date,
        periods_3h
      })
    )

    .sort(
      (a, b) =>
        a.date.localeCompare(
          b.date
        )
    );
}


function addDaysToLocation(location) {

  return {

    ...location,

    days:
      groupPeriodsByDay(
        location.periods_3h
      )
  };
}


/* =========================================================
   ZONES
   ========================================================= */

function buildZones(locations) {

  return ZONES.map(
    zone => ({

      id: zone.id,
      name: zone.name,

      locations:
        locations.filter(
          location =>
            location
              .zones
              .includes(
                zone.id
              )
        )
    })
  );
}


/* =========================================================
   OVERVIEW / STATUS
   ========================================================= */

function buildLocationStatus(location) {

  const periods =
    Array.isArray(location.periods_3h)
      ? location.periods_3h
      : [];


  const active =
    periods.length > 0;


  const forecastFrom =
    active
      ? periods[0].start ?? null
      : null;


  const forecastTo =
    active
      ? periods[
          periods.length - 1
        ].end ?? null
      : null;


  return {

    id:
      location.id,

    name:
      location.name,

    provider:
      location.provider,

    model:
      location.model ?? null,

    zones:
      location.zones || [],

    active,

    periods_available:
      periods.length,

    forecast_from:
      forecastFrom,

    forecast_to:
      forecastTo
  };
}


function buildOverview(locations) {

  const locationStatus =
    locations
      .map(buildLocationStatus)
      .sort(
        (a, b) =>
          a.name.localeCompare(
            b.name,
            "it"
          )
      );


  const activeLocations =
    locationStatus.filter(
      loc => loc.active
    ).length;


  const inactiveLocations =
    locationStatus.length -
    activeLocations;


  const meteoreportStatus =
    locationStatus.filter(
      loc =>
        loc.provider ===
        "meteo.report"
    );


  const openmeteoStatus =
    locationStatus.filter(
      loc =>
        loc.provider ===
        "open-meteo"
    );


  return {

    total_locations:
      locationStatus.length,

    active_locations:
      activeLocations,

    inactive_locations:
      inactiveLocations,

    all_active:
      inactiveLocations === 0,


    providers: {

      meteoreport: {

        total:
          meteoreportStatus.length,

        active:
          meteoreportStatus.filter(
            loc => loc.active
          ).length,

        inactive:
          meteoreportStatus.filter(
            loc => !loc.active
          ).length
      },


      openmeteo: {

        total:
          openmeteoStatus.length,

        active:
          openmeteoStatus.filter(
            loc => loc.active
          ).length,

        inactive:
          openmeteoStatus.filter(
            loc => !loc.active
          ).length
      }
    },


    locations:
      locationStatus
  };
}


/* =========================================================
   SERVICE BINDINGS
   ========================================================= */

async function fetchSources(env) {

  const meteoreportRequest =
    new Request(
      "https://meteoreport.internal/forecast"
    );


  const openmeteoRequest =
    new Request(
      "https://openmeteo.internal/forecast"
    );


  const [
    meteoreportResponse,
    openmeteoResponse
  ] = await Promise.all([

    env.METEOREPORT.fetch(
      meteoreportRequest
    ),

    env.OPENMETEO.fetch(
      openmeteoRequest
    )
  ]);


  if (
    !meteoreportResponse.ok
  ) {

    throw new Error(
      `METEOREPORT HTTP ${meteoreportResponse.status}`
    );
  }


  if (
    !openmeteoResponse.ok
  ) {

    throw new Error(
      `OPENMETEO HTTP ${openmeteoResponse.status}`
    );
  }


  const [
    meteoreport,
    openmeteo
  ] = await Promise.all([

    meteoreportResponse.json(),

    openmeteoResponse.json()
  ]);


  return {
    meteoreport,
    openmeteo
  };
}


/* =========================================================
   BUILD FULL AGGREGATOR
   ========================================================= */

function buildAggregator(
  meteoreport,
  openmeteo
) {

  const meteoreportLocations =
    (meteoreport.locations || [])

      .filter(
        loc =>
          loc.ok !== false
      )

      .map(
        normalizeMeteoReportLocation
      );


  const openmeteoLocations =
    (openmeteo.locations || [])

      .map(
        normalizeOpenMeteoLocation
      );


  const locations = [

    ...meteoreportLocations,
    ...openmeteoLocations

  ].map(
    addDaysToLocation
  );


  const overview =
    buildOverview(locations);


  const zones =
    buildZones(locations);


  return {

    schema_version:
      "1.2",

    generated_at:
      new Date().toISOString(),

    timezone:
      "Europe/Rome",

    interval_minutes:
      180,

    cache_ttl_seconds:
      CACHE_TTL,


    overview,


    sources: {

      meteoreport: {

        ok: true,

        locations:
          meteoreportLocations.length,

        generated_at:
          meteoreport
            .generated_at ?? null
      },


      openmeteo: {

        ok: true,

        model:
          openmeteo.model ??
          "icon_d2",

        locations:
          openmeteoLocations.length,

        generated_at:
          openmeteo
            .generated_at ?? null
      }
    },


    total_unique_locations:
      locations.length,

    total_zones:
      zones.length,


    zones,

    locations,


    raw: {
      meteoreport,
      openmeteo
    }
  };
}


/* =========================================================
   RESPONSE HELPERS
   ========================================================= */

function jsonResponse(
  data,
  status = 200
) {

  return Response.json(
    data,
    {
      status,

      headers: {
        ...CORS_HEADERS,

        "Cache-Control":
          `public, max-age=${CACHE_TTL}`
      }
    }
  );
}


function notFound(message) {

  return jsonResponse(
    {
      ok: false,
      error: message
    },
    404
  );
}


/* =========================================================
   ROUTING
   ========================================================= */

export default {

  async fetch(
    request,
    env
  ) {

    const url =
      new URL(
        request.url
      );


    if (
      request.method ===
      "OPTIONS"
    ) {

      return new Response(
        null,
        {
          status: 204,
          headers:
            CORS_HEADERS
        }
      );
    }


    if (
      request.method !==
      "GET"
    ) {

      return jsonResponse(
        {
          ok: false,
          error:
            "Method not allowed"
        },
        405
      );
    }


    try {

      const {
        meteoreport,
        openmeteo
      } =
        await fetchSources(
          env
        );


      const aggregator =
        buildAggregator(
          meteoreport,
          openmeteo
        );


      const path =
        url.pathname
          .replace(
            /\/+$/,
            ""
          ) || "/";


      /* ===============================================
         FULL FORECAST
         =============================================== */

      if (
        path === "/" ||
        path === "/forecast" ||
        path === "/gite-previsioni.json"
      ) {

        return jsonResponse(
          aggregator
        );
      }


      /* ===============================================
         STATUS
         =============================================== */

      if (
        path === "/status"
      ) {

        return jsonResponse({

          schema_version:
            aggregator.schema_version,

          generated_at:
            aggregator.generated_at,

          timezone:
            aggregator.timezone,

          overview:
            aggregator.overview,

          sources:
            aggregator.sources
        });
      }


      /* ===============================================
         LOCATION
         /location/:id
         =============================================== */

      if (
        path.startsWith(
          "/location/"
        )
      ) {

        const id =
          decodeURIComponent(
            path.slice(
              "/location/".length
            )
          );


        const location =
          aggregator.locations.find(
            loc =>
              loc.id === id
          );


        if (!location) {

          return notFound(
            `Località non trovata: ${id}`
          );
        }


        return jsonResponse({

          schema_version:
            aggregator.schema_version,

          generated_at:
            aggregator.generated_at,

          location
        });
      }


      /* ===============================================
         ZONE
         /zone/:id
         =============================================== */

      if (
        path.startsWith(
          "/zone/"
        )
      ) {

        const id =
          decodeURIComponent(
            path.slice(
              "/zone/".length
            )
          );


        const zone =
          aggregator.zones.find(
            z =>
              z.id === id
          );


        if (!zone) {

          return notFound(
            `Zona non trovata: ${id}`
          );
        }


        return jsonResponse({

          schema_version:
            aggregator.schema_version,

          generated_at:
            aggregator.generated_at,

          zone
        });
      }


      /* ===============================================
         RAW METEOREPORT COMPLETO
         =============================================== */

      if (
        path ===
        "/raw/meteoreport"
      ) {

        return jsonResponse(
          meteoreport
        );
      }


      /* ===============================================
         RAW OPENMETEO COMPLETO
         =============================================== */

      if (
        path ===
        "/raw/openmeteo"
      ) {

        return jsonResponse(
          openmeteo
        );
      }


      /* ===============================================
         RAW METEOREPORT LOCATION
         =============================================== */

      if (
        path.startsWith(
          "/raw/meteoreport/"
        )
      ) {

        const id =
          decodeURIComponent(
            path.slice(
              "/raw/meteoreport/"
                .length
            )
          );


        const location =
          (
            meteoreport.locations ||
            []
          ).find(
            loc =>
              loc.id === id
          );


        if (!location) {

          return notFound(
            `Raw Meteo.report non trovato: ${id}`
          );
        }


        return jsonResponse(
          location
        );
      }


      /* ===============================================
         RAW OPENMETEO LOCATION
         =============================================== */

      if (
        path.startsWith(
          "/raw/openmeteo/"
        )
      ) {

        const id =
          decodeURIComponent(
            path.slice(
              "/raw/openmeteo/"
                .length
            )
          );


        const location =
          (
            openmeteo.locations ||
            []
          ).find(
            loc =>
              loc.id === id
          );


        if (!location) {

          return notFound(
            `Raw Open-Meteo non trovato: ${id}`
          );
        }


        return jsonResponse(
          location
        );
      }


      return notFound(
        "Endpoint non trovato"
      );


    } catch (error) {

      return jsonResponse(
        {
          ok: false,

          error:
            error?.message ||
            String(error),

          generated_at:
            new Date()
              .toISOString()
        },
        502
      );
    }
  }
};
