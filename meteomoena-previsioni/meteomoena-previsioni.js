/*
 * MoenaLive - previsione fissa di Moena da meteo.report.
 * Il formato e' intenzionalmente uguale a meteopozza-previsioni.
 */

const CACHE_TTL = 30 * 60;
const UPSTREAM_TIMEOUT_MS = 12_000;

const LOCATION = {
  id: "moena",
  name: "Moena",
  sourceId: "a35c1ca5-1a8a-4db2-89be-8fa4b5c0bee0"
};

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": `public, max-age=${CACHE_TTL}`,
    ...extra
  };
}

function upstreamUrl(sourceId) {
  return `https://meteo.report/var/data/forecasts/${sourceId}.json`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

// Meteo.report restituisce start come orario locale senza suffisso. Lo
// trattiamo come una scala temporale neutra e usiamo sempre i metodi UTC:
// in questo modo 08:00 resta 08:00 anche se il runtime cambia fuso orario.
function sourceDate(value) {
  const text = String(value || "");
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  return new Date(hasTimezone ? text : `${text}Z`);
}

function formatDate(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function formatTime(date) {
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
}

function offsetFromKey(key, prefix) {
  if (!String(key).startsWith(prefix)) return null;
  const value = Number(String(key).slice(prefix.length));
  return Number.isFinite(value) ? value : null;
}

function buildDate(start, offsetMinutes) {
  const date = sourceDate(start);
  date.setUTCMinutes(date.getUTCMinutes() + offsetMinutes);
  return date;
}

function normalizeHourly(start, forecast180) {
  if (!forecast180 || typeof forecast180 !== "object") return [];
  return Object.entries(forecast180)
    .map(([key, value]) => {
      const offset = offsetFromKey(key, "180");
      if (offset === null) return null;
      const date = buildDate(start, offset);
      if (Number.isNaN(date.getTime())) return null;
      return {
        date: formatDate(date),
        time: formatTime(date),
        temp: value.temperature ?? null,
        code: value.sky_condition ?? null,
        rain: value.rain_fall ?? null,
        rainProb: value.rain_probability ?? null,
        wind: value.wind_speed ?? null,
        gust: value.wind_gust ?? null,
        dir: value.wind_direction ?? null
      };
    })
    .filter(Boolean)
    .sort((first, second) =>
      `${first.date}T${first.time}`.localeCompare(`${second.date}T${second.time}`)
    );
}

function normalizeDaily(start, forecast1440) {
  if (!forecast1440 || typeof forecast1440 !== "object") return [];
  return Object.entries(forecast1440)
    .map(([key, value]) => {
      const offset = offsetFromKey(key, "1440");
      if (offset === null) return null;
      const date = buildDate(start, offset);
      if (Number.isNaN(date.getTime())) return null;
      return {
        date: formatDate(date),
        min: value.temperature_minimum ?? null,
        max: value.temperature_maximum ?? null,
        code: value.sky_condition ?? null,
        rain: value.rain_fall ?? null,
        rainProb: value.rain_probability ?? null,
        wind: value.wind_speed ?? null,
        gust: value.wind_gust ?? null,
        dir: value.wind_direction ?? null
      };
    })
    .filter(Boolean)
    .sort((first, second) => first.date.localeCompare(second.date));
}

function mergeDays(daily, hourly) {
  const byDate = new Map();
  for (const day of daily) byDate.set(day.date, { ...day, hours: [] });

  for (const hour of hourly) {
    if (!byDate.has(hour.date)) {
      byDate.set(hour.date, {
        date: hour.date,
        min: null,
        max: null,
        code: null,
        rain: null,
        rainProb: null,
        wind: null,
        gust: null,
        dir: null,
        hours: []
      });
    }
    const { date, ...hourData } = hour;
    byDate.get(date).hours.push(hourData);
  }

  return Array.from(byDate.values())
    .sort((first, second) => first.date.localeCompare(second.date));
}

async function fetchForecast() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(upstreamUrl(LOCATION.sourceId), {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; MoenaLive/1.0)"
      },
      signal: controller.signal,
      cf: {
        cacheTtl: CACHE_TTL,
        cacheEverything: true
      }
    });
    if (!response.ok) throw new Error(`Meteo.report HTTP ${response.status}`);
    const data = await response.json();
    if (!data?.start) throw new Error("Meteo.report response without start date");

    const hourly = normalizeHourly(data.start, data["180"]);
    const daily = normalizeDaily(data.start, data["1440"]);
    const days = mergeDays(daily, hourly);
    if (!days.length) throw new Error("Meteo.report response without forecast periods");

    return {
      source: "meteo.report",
      location: {
        id: LOCATION.id,
        name: LOCATION.name,
        source_id: LOCATION.sourceId
      },
      generated_at: new Date().toISOString(),
      source_start: data.start ?? null,
      source_end: data.end ?? null,
      interval_minutes: 180,
      days_count: days.length,
      days
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Meteo.report timeout dopo ${UPSTREAM_TIMEOUT_MS} ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== "GET") {
      return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
        status: 405,
        headers: corsHeaders()
      });
    }
    if (url.pathname !== "/" && url.pathname !== "/forecast") {
      return new Response(JSON.stringify({
        ok: false,
        error: "Not found",
        endpoints: ["/", "/forecast"]
      }), {
        status: 404,
        headers: corsHeaders()
      });
    }

    const edgeCache = globalThis.caches?.default || null;
    const cacheKey = new Request(`${url.origin}/forecast`, { method: "GET" });
    const cached = edgeCache ? await edgeCache.match(cacheKey) : null;
    if (cached) {
      const response = new Response(cached.body, {
        status: cached.status,
        headers: cached.headers
      });
      response.headers.set("Access-Control-Allow-Origin", "*");
      response.headers.set("Cache-Control", `public, max-age=${CACHE_TTL}`);
      response.headers.set("X-Worker-Cache", "HIT");
      return response;
    }

    try {
      const payload = await fetchForecast();
      const response = new Response(JSON.stringify(payload), {
        status: 200,
        headers: corsHeaders({ "X-Worker-Cache": "MISS" })
      });
      if (edgeCache) await edgeCache.put(cacheKey, response.clone());
      return response;
    } catch (error) {
      return new Response(JSON.stringify({
        ok: false,
        source: "meteo.report",
        location: LOCATION.name,
        error: "Forecast upstream unavailable",
        detail: String(error?.message || error)
      }), {
        status: 502,
        headers: corsHeaders()
      });
    }
  }
};
