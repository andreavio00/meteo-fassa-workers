export default {
  async fetch(request, env, ctx) {

    const url = new URL(request.url);

    const VIGO_URL =
      "https://stazioni.meteoproject.it/dati/vigodifassa/dati.php";

    const MONZON_URL =
      "https://www.meteonetwork.eu/it/weather-station/trn314-stazione-meteorologica-di-monzon";

    const PEZZE_URL =
      "https://www.meteonetwork.eu/it/weather-station/trn352-stazione-meteorologica-di-frazione-pezze";

    const MOENA_URL =
      "https://www.moenameteo.it/joomla/wview/Current.htm";

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Cache-Control": "no-store"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    if (request.method !== "GET") {
      return new Response("Metodo non consentito", {
        status: 405,
        headers: corsHeaders
      });
    }

    /*
     * FIX AFFIDABILITA' (settembre 2026)
     * ----------------------------------
     * Prima le fonti venivano recuperate con un solo Promise.all "secco":
     * se anche una sola (tipicamente Moena, la piu' lenta) restava bloccata
     * o ci metteva troppo, l'intera richiesta scadeva oltre il timeout lato
     * frontend (7s) e sparivano anche i dati delle altre stazioni, gia'
     * pronti da tempo. Ora ogni fonte ha un timeout individuale via
     * AbortController: una fonte lenta non blocca piu' le altre.
     */
    const SOURCE_TIMEOUT_MS = 5000;

    async function fetchSource(sourceUrl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
      try {
        const response = await fetch(sourceUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; MeteoFassaWorker/1.0)",
            "Accept": "text/html,application/xhtml+xml"
          },
          signal: controller.signal
        });
        const html = await response.text();
        return { ok: true, status: response.status, html, errore: null };
      } catch (error) {
        const timedOut = controller.signal.aborted;
        return {
          ok: false,
          status: null,
          html: null,
          errore: timedOut ? `Timeout dopo ${SOURCE_TIMEOUT_MS}ms` : error.toString()
        };
      } finally {
        clearTimeout(timer);
      }
    }

    /*
     * Cache di riserva su Cloudflare KV (binding "METEO_CACHE", opzionale).
     * Se una fonte non risponde in tempo, invece di lasciare la scheda
     * vuota serviamo l'ultimo dato buono salvato (il frontend lo mostra
     * comunque, e l'indicatore di eta' si occupa gia' da solo di segnalarlo
     * come "vecchio" in base al suo orario di rilevazione originale).
     * Se il binding non e' configurato il worker funziona lo stesso, solo
     * senza questa rete di sicurezza.
     */
    async function readCache(name) {
      if (!env || !env.METEO_CACHE) return null;
      try {
        const raw = await env.METEO_CACHE.get(`stazione:${name}`);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    }

    async function writeCache(name, parsed) {
      if (!env || !env.METEO_CACHE) return;
      try {
        await env.METEO_CACHE.put(
          `stazione:${name}`,
          JSON.stringify(parsed),
          { expirationTtl: 21600 } // 6 ore: oltre non ha piu' senso mostrarlo come "ultimo dato buono"
        );
      } catch {
        /* KV non configurata o momentaneamente non disponibile: non blocchiamo la risposta */
      }
    }

    const [vigoRes, monzonRes, pezzeRes, moenaRes] = await Promise.all([
      fetchSource(VIGO_URL),
      fetchSource(MONZON_URL),
      fetchSource(PEZZE_URL),
      fetchSource(MOENA_URL)
    ]);

    /*
     * Debug RAW: se la fonte non ha risposto in tempo restituiamo il
     * messaggio d'errore al posto dell'HTML (prima l'intera richiesta
     * sarebbe fallita con un 500).
     */
    const raw = url.searchParams.get("raw");
    const rawMap = { vigo: vigoRes, monzon: monzonRes, pezze: pezzeRes, moena: moenaRes };
    if (raw && rawMap[raw]) {
      const r = rawMap[raw];
      return new Response(r.ok ? r.html : `Errore: ${r.errore}`, {
        status: r.ok ? r.status : 502,
        headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" }
      });
    }

    /*
     * Per ogni stazione: se la fonte ha risposto la parsiamo e aggiorniamo
     * la cache; se non ha risposto proviamo a servire l'ultimo dato buono
     * salvato (segnalato con stato "stale"); se non c'e' nemmeno quello la
     * stazione risulta null (il frontend mostra gia' "dati non disponibili"
     * solo per quella scheda, senza far sparire le altre due).
     */
    async function buildStation(name, fetchResult, parseFn) {
      if (fetchResult.ok) {
        try {
          const parsed = { ...parseFn(fetchResult.html), http: fetchResult.status, stato: "ok" };
          await writeCache(name, parsed);
          return parsed;
        } catch (error) {
          // La fonte ha risposto ma il parsing e' esploso (pagina cambiata,
          // HTML inatteso...): trattiamolo come una fonte non disponibile
          // invece di far fallire tutta la richiesta.
          fetchResult = { ok: false, errore: `Parsing fallito: ${error.toString()}` };
        }
      }

      const cached = await readCache(name);
      if (cached) {
        return { ...cached, http: null, stato: "stale", erroreRete: fetchResult.errore };
      }

      return null;
    }

    const [vigo, monzon, pezze, moena] = await Promise.all([
      buildStation("vigo", vigoRes, parseVigo),
      buildStation("monzon", monzonRes, parseMonzon),
      buildStation("pezze", pezzeRes, parsePezze),
      buildStation("moena", moenaRes, parseMoena)
    ]);

    const risultato = {
      ok: true,
      timestamp: new Date().toISOString(),
      vigo,
      monzon,
      pezze,
      moena
    };

    return new Response(
      JSON.stringify(risultato, null, 2),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json; charset=utf-8"
        }
      }
    );
  }
};


/* ======================================================
   FUNZIONI GENERALI
   ====================================================== */

function cleanText(value) {

  if (!value) return "";

  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&deg;/gi, "°")
    .replace(/&#176;/gi, "°")
    .replace(/&agrave;/gi, "à")
    .replace(/&egrave;/gi, "è")
    .replace(/&igrave;/gi, "ì")
    .replace(/&ograve;/gi, "ò")
    .replace(/&ugrave;/gi, "ù")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();

}

function numberValue(value) {

  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const match =
    String(value)
      .replace(",", ".")
      .match(/-?\d+(?:\.\d+)?/);

  return match
    ? Number(match[0])
    : null;

}

function cleanTime(value) {

  if (!value) return null;

  return value
    .trim()
    .replace(".", ":");

}

/* ======================================================
   VIGO
   ====================================================== */

function getVigoRows(html) {

  return html.match(
    /<tr[\s\S]*?<\/tr>/gi
  ) || [];

}

function getVigoCells(row) {

  return row.match(
    /<td[\s\S]*?<\/td>/gi
  ) || [];

}

function getVigoRowData(html, label) {

  const rows =
    getVigoRows(html);

  const wanted =
    label.toLowerCase().trim();

  for (const row of rows) {

    const cells =
      getVigoCells(row);

    if (cells.length < 3)
      continue;

    const labelText =
      cleanText(cells[1])
        .toLowerCase()
        .trim();

    if (labelText !== wanted)
      continue;

    return {

      attuale:
        cleanText(cells[2]),

      min:
        cells[3]
          ? cleanText(cells[3])
          : null,

      ora_min:
        cells[4]
          ? cleanTime(cleanText(cells[4]))
          : null,

      max:
        cells[5]
          ? cleanText(cells[5])
          : null,

      ora_max:
        cells[6]
          ? cleanTime(cleanText(cells[6]))
          : null

    };

  }

  return null;

}

/* ======================================================
   VIGO - ORARIO DI RILEVAZIONE
   ====================================================== */

/*
 * La pagina mostra in cima:
 * "Dati aggiornati il 30/08/26 alle ore 10.18"
 * Questo è il vero orario di rilevazione della stazione
 * (compare due volte nella pagina, versione desktop e
 * mobile: prendiamo la prima occorrenza).
 *
 * NB: l'orario è locale Italia. Costruiamo un ISO string
 * con offset fisso +02:00 (ora legale). Da correggere a
 * +01:00 manualmente nel periodo di ora solare
 * (fine ottobre - fine marzo).
 */

function parseVigoTimestamp(html) {

  const match =
    html.match(
      /Dati aggiornati il[\s\S]{0,60}?(\d{2})\/(\d{2})\/(\d{2})[\s\S]{0,80}?alle ore[\s\S]{0,60}?(\d{1,2})\.(\d{2})/i
    );

  if (!match) return null;

  const [, dd, mm, yy, hh, min] = match;

  const year = 2000 + Number(yy);

  const pad =
    (n) => String(n).padStart(2, "0");

  return `${year}-${mm}-${dd}T${pad(hh)}:${min}:00+02:00`;

}

/* ======================================================
   VIGO PARSER
   ====================================================== */

function parseVigo(html) {

  const result = {

    stazione:
      "Vigo di Fassa",

    temperatura: null,
    umidita: null,
    dew_point: null,
    heat_index: null,
    pressione: null,
    wind_chill: null,

    temperatura_interna: null,
    umidita_interna: null,

    vento: {
      attuale: null,
      media_10_min: null,
      raffica: null,
      ora_raffica: null,
      direzione: null
    },

    precipitazioni: {
      intensita: null,
      intensita_massima: null,
      giornaliero: null,
      mensile: null,
      storm_rain: null,
      annuale: null
    },

    aggiornamento: null

  };

  const temperatura =
    getVigoRowData(html, "Temperatura");

  if (temperatura) {

    result.temperatura = {
      attuale:
        numberValue(temperatura.attuale),

      min:
        numberValue(temperatura.min),

      ora_min:
        temperatura.ora_min,

      max:
        numberValue(temperatura.max),

      ora_max:
        temperatura.ora_max
    };

  }

  const umidita =
    getVigoRowData(html, "Umidità");

  if (umidita) {

    result.umidita = {
      attuale:
        numberValue(umidita.attuale),

      min:
        numberValue(umidita.min),

      ora_min:
        umidita.ora_min,

      max:
        numberValue(umidita.max),

      ora_max:
        umidita.ora_max
    };

  }

  const dewPoint =
    getVigoRowData(html, "Dew Point");

  if (dewPoint) {

    result.dew_point = {
      attuale:
        numberValue(dewPoint.attuale),

      min:
        numberValue(dewPoint.min),

      ora_min:
        dewPoint.ora_min,

      max:
        numberValue(dewPoint.max),

      ora_max:
        dewPoint.ora_max
    };

  }

  const heatIndex =
    getVigoRowData(html, "Heat Index");

  if (heatIndex) {

    result.heat_index = {
      attuale:
        numberValue(heatIndex.attuale),

      min:
        numberValue(heatIndex.min),

      ora_min:
        heatIndex.ora_min,

      max:
        numberValue(heatIndex.max),

      ora_max:
        heatIndex.ora_max
    };

  }

  const pressione =
    getVigoRowData(html, "Pressione");

  if (pressione) {

    result.pressione = {
      attuale:
        numberValue(pressione.attuale),

      min:
        numberValue(pressione.min),

      ora_min:
        pressione.ora_min,

      max:
        numberValue(pressione.max),

      ora_max:
        pressione.ora_max
    };

  }

  const windChill =
    getVigoRowData(html, "Wind Chill");

  if (windChill) {

    result.wind_chill = {
      attuale:
        numberValue(windChill.attuale),

      min:
        numberValue(windChill.min),

      ora_min:
        windChill.ora_min,

      max:
        numberValue(windChill.max),

      ora_max:
        windChill.ora_max
    };

  }

  const tempInterna =
    getVigoRowData(html, "Temp. Interna");

  if (tempInterna) {

    result.temperatura_interna = {
      attuale:
        numberValue(tempInterna.attuale),

      min:
        numberValue(tempInterna.min),

      max:
        numberValue(tempInterna.max)
    };

  }

  const umiditaInterna =
    getVigoRowData(html, "Umid. Interna");

  if (umiditaInterna) {

    result.umidita_interna = {
      attuale:
        numberValue(umiditaInterna.attuale),

      min:
        numberValue(umiditaInterna.min),

      max:
        numberValue(umiditaInterna.max)
    };

  }

  /*
   * VENTO
   */

  const velocita =
    getVigoRowData(html, "Velocità");

  if (velocita) {

    /*
     * FIX: nella tabella di Vigo la colonna "attuale"
     * (subito dopo l'etichetta) è la velocità istantanea,
     * mentre la colonna generica "min" corrisponde in
     * realtà all'intestazione "MEDIA 10 MIN" di questo
     * blocco. In precedenza erano scambiate.
     */

    result.vento.attuale =
      numberValue(velocita.attuale);

    result.vento.media_10_min =
      numberValue(velocita.min);

    result.vento.raffica =
      numberValue(velocita.max);

    result.vento.ora_raffica =
      velocita.ora_max;

  }

  /*
   * DIREZIONE
   */

  const direzione =
    getVigoRowData(html, "Direzione");

  if (direzione) {

    const match =
      direzione.attuale.match(
        /\b([NSEW]{1,3})\b/i
      );

    if (match) {

      result.vento.direzione =
        match[1].toUpperCase();

    }

  }

  /*
   * PIOGGIA
   */

  const pioggia =
    getVigoRowData(
      html,
      "Intensità di Pioggia"
    );

  if (pioggia) {

    result.precipitazioni.intensita =
      numberValue(pioggia.attuale);

    result.precipitazioni.giornaliero =
      numberValue(pioggia.min);

  }

  const pioggiaMax =
    getVigoRowData(
      html,
      "Intensità Massima"
    );

  if (pioggiaMax) {

    result.precipitazioni.intensita_massima =
      numberValue(pioggiaMax.attuale);

    result.precipitazioni.mensile =
      numberValue(pioggiaMax.min);

  }

  const stormRain =
    getVigoRowData(
      html,
      "Storm Rain"
    );

  if (stormRain) {

    result.precipitazioni.storm_rain =
      numberValue(stormRain.attuale);

    result.precipitazioni.annuale =
      numberValue(stormRain.min);

  }

  result.aggiornamento =
    parseVigoTimestamp(html);

  return result;

}

/* ======================================================
   MONZON
   ====================================================== */

function parseMonzon(html) {

  const result = {

    stazione:
      "Monzon - Pozza di Fassa",

    temperatura: null,
    temperatura_min: null,
    temperatura_max: null,
    umidita: null,
    pressione: null,
    pioggia: null,
    pioggia_rate: null,
    vento: null,
    direzione: null,
    raffica: null,
    vento_medio: null,
    dew_point: null,
    heat_index: null,
    radiazione_solare: null,
    uv: null,
    aggiornamento: null

  };

  const text =
    html
      .replace(
        /<script[\s\S]*?<\/script>/gi,
        " "
      )
      .replace(
        /<style[\s\S]*?<\/style>/gi,
        " "
      )
      .replace(
        /<[^>]+>/g,
        " "
      )
      .replace(
        /&nbsp;/gi,
        " "
      )
      .replace(
        /&deg;/gi,
        "°"
      )
      .replace(
        /&#176;/gi,
        "°"
      )
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  let match;

  // Nella pagina MeteoNetwork i tre valori che seguono il titolo sono,
  // nell'ordine, temperatura attuale, massima e minima giornaliera.
  match = text.match(
    /Temperatura\s+(-?\d+(?:[.,]\d+)?)\s*°C\s+(-?\d+(?:[.,]\d+)?)\s*°C\s+(-?\d+(?:[.,]\d+)?)\s*°C/i
  );

  if (match) {
    result.temperatura = numberValue(match[1]);
    result.temperatura_max = numberValue(match[2]);
    result.temperatura_min = numberValue(match[3]);
  }

  match =
    text.match(
      /Temperatura\s+(-?\d+(?:[.,]\d+)?)\s*°C/i
    );

  if (match && result.temperatura === null)
    result.temperatura =
      numberValue(match[1]);

  match =
    text.match(
      /Umidità\s+(\d+(?:[.,]\d+)?)\s*%/i
    );

  if (match)
    result.umidita =
      numberValue(match[1]);

  match =
    text.match(
      /Pressione\s+(\d+(?:[.,]\d+)?)\s*hPa/i
    );

  if (match)
    result.pressione =
      numberValue(match[1]);

  match =
    text.match(
      /Pioggia\s+(\d+(?:[.,]\d+)?)\s*mm/i
    );

  if (match)
    result.pioggia =
      numberValue(match[1]);

  match =
    text.match(
      /Pioggia\s+\d+(?:[.,]\d+)?\s*mm\s*\(\s*(\d+(?:[.,]\d+)?)\s*mm\/h/i
    );

  if (match)
    result.pioggia_rate =
      numberValue(match[1]);

  match =
    text.match(
      /Vento\s+(\d+(?:[.,]\d+)?)\s*km\/h\s*\(([^)]+)\)/i
    );

  if (match) {

    result.vento =
      numberValue(match[1]);

    result.direzione =
      match[2].trim();

  }

  match =
    text.match(
      /Raffica\s+(\d+(?:[.,]\d+)?)\s*km\/h/i
    );

  if (match)
    result.raffica =
      numberValue(match[1]);

  match =
    text.match(
      /Vel\.\s*media\s+(\d+(?:[.,]\d+)?)\s*km\/h/i
    );

  if (match)
    result.vento_medio =
      numberValue(match[1]);

  match =
    text.match(
      /Temp\.\s*di\s*rugiada\s+(-?\d+(?:[.,]\d+)?)\s*°C/i
    );

  if (match)
    result.dew_point =
      numberValue(match[1]);

  match =
    text.match(
      /Indice\s+di\s+calore\s+(-?\d+(?:[.,]\d+)?)\s*°C/i
    );

  if (match)
    result.heat_index =
      numberValue(match[1]);

  match =
    text.match(
      /Radiazione\s+solare\s+(\d+(?:[.,]\d+)?)\s*W\/m2/i
    );

  if (match)
    result.radiazione_solare =
      numberValue(match[1]);

  match =
    text.match(
      /Radiazione\s+UV\s+(\d+(?:[.,]\d+)?)/i
    );

  if (match)
    result.uv =
      numberValue(match[1]);

  /*
   * L'orario ricavato in precedenza dal grafico si è rivelato inaffidabile
   * (fino a 2 ore di ritardo). La pagina però calcola anche un vero e
   * proprio "Ultimo rilevamento" lato client, a partire da due numeri che
   * il server scrive direttamente nello script (es. "let maxTHour = 08 -
   * hours;" e "let maxTMin = 32 - parseInt(minutes);"): quei numeri (08 e
   * 32 in questo esempio) sono l'orario UTC vero dell'ultima lettura. Il
   * client li converte in locale sottraendo l'offset del proprio fuso
   * orario (che è già in minuti, di segno invertito). Usiamo direttamente
   * quei due numeri: essendo già UTC non serve nessun offset a mano, e
   * quindi non ci sono problemi di ora legale/solare.
   */
  result.aggiornamento = parseMonzonTimestampReal(html);

  return result;

}

// TRN352 usa la stessa pagina e lo stesso formato di Monzon (TRN314).
// Manteniamo quindi un solo parser e cambiamo soltanto l'identità esposta.
function parsePezze(html) {
  const result = parseMonzon(html);
  result.stazione = "Frazione Pezzè - Moena";
  return result;
}

/* ======================================================
   MONZON - ORARIO DI RILEVAZIONE
   ====================================================== */

/*
 * Estrae l'orario UTC reale scritto dal server nello script della pagina
 * (variabili "maxTHour" / "maxTMin") e la data (anch'essa scritta dal
 * server). Molto più affidabile del vecchio metodo basato sull'ultimo
 * punto del grafico Highcharts, che poteva restare indietro di ore.
 */

function parseMonzonTimestampReal(html) {

  const hourMatch =
    html.match(/let\s+maxTHour\s*=\s*(\d{1,2})\s*-\s*hours/);

  const minMatch =
    html.match(/let\s+maxTMin\s*=\s*(\d{1,2})\s*-\s*parseInt\(minutes\)/);

  const dateMatch =
    html.match(/'\s*del\s*'\s*\+\s*'(\d{4}-\d{2}-\d{2})'/);

  if (!hourMatch || !minMatch || !dateMatch) return null;

  const pad =
    (n) => String(n).padStart(2, "0");

  const hh = pad(hourMatch[1]);
  const mi = pad(minMatch[1]);

  // "Z" perché questi valori sono già UTC vero, scritti dal server.
  return `${dateMatch[1]}T${hh}:${mi}:00Z`;

}

/*
 * NOTA STORICA: in precedenza l'orario di Monzon veniva ricavato dall'ultimo
 * punto dei grafici Highcharts della pagina. Si è rivelato inaffidabile
 * (fino a 2 ore di ritardo rispetto ai valori reali), quindi è stato
 * sostituito da parseMonzonTimestampReal() sopra, basato sulle variabili
 * "maxTHour"/"maxTMin" scritte dal server — molto più preciso.
 */

/* ======================================================
   MOENA
   ====================================================== */

/*
 * MoenaMeteo utilizza una vecchia pagina HTML
 * nella quale i dati sono organizzati principalmente
 * in righe:
 *
 * <tr>
 *   <td>Nome dato</td>
 *   <td>Valore</td>
 * </tr>
 *
 * Esempi reali:
 *
 * Temperatura     -> 10.3 °C
 * Punto rugiada   -> 8.7 °C
 * Pressione       -> 1016.1 hPa
 * Umidità         -> 90 %
 * Dir. e velocità vento -> NNE con 0.0 km/h
 * Pioggia Giorno  -> 0.00 mm
 */

function getMoenaRows(html) {

  return html.match(
    /<tr[\s\S]*?<\/tr>/gi
  ) || [];

}

function getMoenaCells(row) {

  return row.match(
    /<td[\s\S]*?<\/td>/gi
  ) || [];

}

/*
 * MOENA - ORARIO DI RILEVAZIONE
 *
 * In cima alla pagina compare in chiaro:
 * "Dati meteo attuali" seguito da "30/08/2026 10:21:10"
 * Questo è l'orario reale (e il formato più affidabile
 * fra le tre stazioni).
 */

function parseMoenaTimestamp(html) {

  const match =
    html.match(
      /Dati meteo attuali[\s\S]{0,60}?(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/i
    );

  if (!match) return null;

  const [, dd, mm, yyyy, hh, mi, ss] = match;

  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+02:00`;

}

function getMoenaRow(html, label) {

  const rows =
    getMoenaRows(html);

  const wanted =
    cleanText(label)
      .toLowerCase()
      .trim();

  for (const row of rows) {

    const cells =
      getMoenaCells(row);

    if (cells.length < 2)
      continue;

    const nome =
      cleanText(cells[0])
        .toLowerCase()
        .trim();

    if (nome === wanted) {

      return cleanText(cells[1]);

    }

  }

  return null;

}

function parseMoena(html) {

  const result = {

    stazione:
      "Moena",

    quota:
      1221,

    coordinate:
      "46.2 N - 11.4 E",

    temperatura: null,

    umidita: null,

    pressione: null,

    dew_point: null,

    wind_chill: null,

    heat_index: null,

    vento: null,

    direzione: null,

    vento_max_giorno: null,

    ora_vento_max: null,

    pioggia: null,

    pioggia_rate: null,

    pioggia_evento: null,

    pioggia_mese: null,

    pioggia_anno: null,

    temperatura_max: null,

    ora_temperatura_max: null,

    temperatura_min: null,

    ora_temperatura_min: null,

    umidita_max: null,

    ora_umidita_max: null,

    umidita_min: null,

    ora_umidita_min: null,

    dew_point_max: null,

    ora_dew_point_max: null,

    dew_point_min: null,

    ora_dew_point_min: null,

    pressione_max: null,

    ora_pressione_max: null,

    pressione_min: null,

    ora_pressione_min: null,

    aggiornamento: null

  };

  /* ----------------------------------------------------
     TEMPERATURA
     ---------------------------------------------------- */

  let value =
    getMoenaRow(html, "Temperatura");




  if (value) {

    result.temperatura =
      numberValue(value);

  }

  /* ----------------------------------------------------
     PUNTO DI RUGIADA
     ---------------------------------------------------- */

  value =
    getMoenaRow(html, "Punto rugiada");

  if (value) {

    result.dew_point =
      numberValue(value);

  }

  /* ----------------------------------------------------
     INDICE RAFFREDDAMENTO
     ---------------------------------------------------- */

  value =
    getMoenaRow(html, "Indice raffr.");

  if (!value) {

    value =
      getMoenaRow(html, "Indice raffr");

  }

  if (value) {

    result.wind_chill =
      numberValue(value);

  }

  /* ----------------------------------------------------
     INDICE CALORE
     ---------------------------------------------------- */

  value =
    getMoenaRow(html, "Indice calore");

  if (!value) {

    value =
      getMoenaRow(html, "Indice Calore");

  }

  if (value) {

    result.heat_index =
      numberValue(value);

  }

  /* ----------------------------------------------------
     PRESSIONE
     ---------------------------------------------------- */

  value =
    getMoenaRow(html, "Pressione");

  if (value) {

    result.pressione =
      numberValue(value);

  }

  /* ----------------------------------------------------
     UMIDITÀ
     ---------------------------------------------------- */

  value =
    getMoenaRow(html, "Umidità");

  if (!value) {

    value =
      getMoenaRow(html, "Umidit&agrave");

  }

  if (value) {

    result.umidita =
      numberValue(value);

  }

  /* ----------------------------------------------------
     VENTO
     ---------------------------------------------------- */

  value =
    getMoenaRow(
      html,
      "Dir. e velocità vento"
    );

  if (!value) {

    value =
      getMoenaRow(
        html,
        "Dir. e velocità vento"
      );

  }

  if (value) {

    /*
     * Esempio reale:
     *
     * NNE con 0.0 km/h
     */

    const windMatch =
      value.match(
        /^([A-Za-z]{1,3})\s+con\s+(-?\d+(?:[.,]\d+)?)\s*km\/h/i
      );

    if (windMatch) {

      result.direzione =
        windMatch[1].toUpperCase();

      result.vento =
        numberValue(windMatch[2]);

    } else {

      /*
       * Fallback nel caso la stazione cambi
       * leggermente la forma del testo.
       */

      const speedMatch =
        value.match(
          /(-?\d+(?:[.,]\d+)?)\s*km\/h/i
        );

      if (speedMatch) {

        result.vento =
          numberValue(speedMatch[1]);

      }

      const directionMatch =
        value.match(
          /\b(N|NNE|NE|ENE|E|ESE|SE|SSE|S|SSW|SW|WSW|W|WNW|NW|NNW)\b/i
        );

      if (directionMatch) {

        result.direzione =
          directionMatch[1].toUpperCase();

      }

    }

  }

  /* ----------------------------------------------------
     PIOGGIA GIORNALIERA
     ---------------------------------------------------- */

  value =
    getMoenaRow(html, "Pioggia Giorno");

  if (value) {

    result.pioggia =
      numberValue(value);

  }

  /* ----------------------------------------------------
     PIOGGIA EVENTO
     ---------------------------------------------------- */

  value =
    getMoenaRow(
      html,
      "Pioggia totale Evento"
    );

  if (value) {

    result.pioggia_evento =
      numberValue(value);

  }

  /* ----------------------------------------------------
     TASSO PIOVOSITÀ
  -------------------------------------------------- */
  value =
    getMoenaRow(
      html,
      "Tasso piovosità"
    );

  if (!value) {

    value =
      getMoenaRow(
        html,
        "Tasso piovosità"
      );

  }

  if (value) {

    result.pioggia_rate =
      numberValue(value);

  }

  /* ----------------------------------------------------
     PIOGGIA MESE
     ---------------------------------------------------- */

  value =
    getMoenaRow(html, "Pioggia Mese");

  if (value) {

    result.pioggia_mese =
      numberValue(value);

  }

  /* ----------------------------------------------------
     PIOGGIA ANNO
     ---------------------------------------------------- */

  value =
    getMoenaRow(html, "Pioggia Anno");

  if (value) {

    result.pioggia_anno =
      numberValue(value);

  }

  /* ====================================================
     MIN / MAX GIORNALIERI
     ==================================================== */

  /* ----------------------------------------------------
     TEMPERATURA MAX / MIN
     ---------------------------------------------------- */

  const tempMaxMin =
    getMoenaRow(
      html,
      "Temperatura Max Temperatura Min"
    );

  /*
   * La struttura reale è una cella con due <p>,
   * quindi la leggiamo direttamente dall'HTML.
   */

  const tempBlock =
    findMoenaBlock(
      html,
      /Temperatura Max/i
    );

  if (tempBlock) {

    const values =
      extractMoenaValuesAndTimes(
        tempBlock,
        /Temperatura Max/i,
        /Temperatura Min/i
      );

    if (values.max) {

      result.temperatura_max =
        numberValue(values.max.value);

      result.ora_temperatura_max =
        values.max.time;

    }

    if (values.min) {

      result.temperatura_min =
        numberValue(values.min.value);

      result.ora_temperatura_min =
        values.min.time;

    }

  }

  /* ----------------------------------------------------
     UMIDITÀ MAX / MIN
     ---------------------------------------------------- */

  const humidityBlock =
    findMoenaBlock(
      html,
      /Umidit[àa]/i
    );

  if (humidityBlock) {

    const values =
      extractMoenaValuesAndTimes(
        humidityBlock,
        /Umidit[àa]\s+Max/i,
        /Umidit[àa]\s+Min/i
      );

    if (values.max) {

      result.umidita_max =
        numberValue(values.max.value);

      result.ora_umidita_max =
        values.max.time;

    }

    if (values.min) {

      result.umidita_min =
        numberValue(values.min.value);

      result.ora_umidita_min =
        values.min.time;

    }

  }

  /* ----------------------------------------------------
     DEW POINT MAX / MIN
     ---------------------------------------------------- */

  const dewBlock =
    findMoenaBlock(
      html,
      /Punto rugiada Max/i
    );

  if (dewBlock) {

    const values =
      extractMoenaValuesAndTimes(
        dewBlock,
        /Punto rugiada Max/i,
        /Punto rugiada Min/i
      );

    if (values.max) {

      result.dew_point_max =
        numberValue(values.max.value);

      result.ora_dew_point_max =
        values.max.time;

    }

    if (values.min) {

      result.dew_point_min =
        numberValue(values.min.value);

      result.ora_dew_point_min =
        values.min.time;

    }

  }

  /* ----------------------------------------------------
     PRESSIONE MAX / MIN
     ---------------------------------------------------- */

  const pressureBlock =
    findMoenaBlock(
      html,
      /Pressione Max/i
    );

  if (pressureBlock) {

    const values =
      extractMoenaValuesAndTimes(
        pressureBlock,
        /Pressione Max/i,
        /Pressione Min/i
      );

    if (values.max) {

      result.pressione_max =
        numberValue(values.max.value);

      result.ora_pressione_max =
        values.max.time;

    }

    if (values.min) {

      result.pressione_min =
        numberValue(values.min.value);

      result.ora_pressione_min =
        values.min.time;

    }

  }

  /* ----------------------------------------------------
     VENTO MASSIMO GIORNALIERO
     ---------------------------------------------------- */

  const windMaxBlock =
    findMoenaBlock(
      html,
      /Velocit[àa] vento Max/i
    );

  if (windMaxBlock) {

    const clean =
      cleanText(windMaxBlock);

    const match =
      clean.match(
        /Velocit[àa] vento Max\s+(-?\d+(?:[.,]\d+)?)\s*km\/h\s+alle\s+(\d{1,2}:\d{2})/i
      );

    if (match) {

      result.vento_max_giorno =
        numberValue(match[1]);

      result.ora_vento_max =
        match[2];

    }

  }

  result.aggiornamento =
    parseMoenaTimestamp(html);

  return result;

}

/* ======================================================
   FUNZIONI DI SUPPORTO MOENA
   ====================================================== */

/*
 * Trova il blocco <tr> che contiene una determinata
 * espressione.
 */

function findMoenaBlock(html, regex) {

  const rows =
    getMoenaRows(html);

  for (const row of rows) {

    const text =
      cleanText(row);

    if (regex.test(text)) {

      return row;

    }

  }

  return null;

}

/*
 * Estrae due valori da una riga/blocco che contiene
 * Max e Min.
 *
 * Esempio reale:
 *
 * Temperatura Max
 * 12.3 °C alle 00:00
 * Temperatura Min
 * 10.3 °C alle 04:01
 */

function extractMoenaValuesAndTimes(
  row,
  maxRegex,
  minRegex
) {

  const result = {
    max: null,
    min: null
  };

  /*
   * Prima estraiamo il testo completo della riga.
   */

  const text =
    cleanText(row);

  /*
   * Cerchiamo tutti i valori con orario.
   */

  const matches =
    [...text.matchAll(
      /(-?\d+(?:[.,]\d+)?)\s*°?\s*C?\s*(?:alle|all'?)\s*(\d{1,2}:\d{2})/gi
    )];

  /*
   * Nel caso della temperatura/dew point ecc.
   * la cella contiene normalmente due <p>.
   * Proviamo quindi direttamente sulle celle.
   */

  const cells =
    getMoenaCells(row);

  if (cells.length >= 2) {

    const valueCell =
      cells[1];

    const paragraphs =
      valueCell.match(
        /<p[\s\S]*?<\/p>/gi
      ) || [];

    const parsed = [];

    for (const p of paragraphs) {

      const pText =
        cleanText(p);

      const m =
        pText.match(
          /(-?\d+(?:[.,]\d+)?)\s*°?\s*C?\s*(?:alle|all'?)\s*(\d{1,2}:\d{2})/i
        );

      if (m) {

        parsed.push({
          value: m[1],
          time: m[2]
        });

      }

    }

    if (parsed.length >= 1) {

      result.max =
        parsed[0];

    }

    if (parsed.length >= 2) {

      result.min =
        parsed[1];

    }

  }

  /*
   * Fallback sul testo completo.
   */

  if (!result.max && matches.length >= 1) {

    result.max = {
      value: matches[0][1],
      time: matches[0][2]
    };

  }

  if (!result.min && matches.length >= 2) {

    result.min = {
      value: matches[1][1],
      time: matches[1][2]
    };

  }

  return result;

}  
