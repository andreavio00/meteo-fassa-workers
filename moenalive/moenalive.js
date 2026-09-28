const UPSTREAM_BASE = new URL("https://andreavio00.github.io/meteo-fassa/");

// La stessa interfaccia viene pubblicata su un'origine autonoma, così Chrome
// non la confonde con la PWA PozzaLive già installata su GitHub Pages.
const PATH_ALIASES = new Map([
  ["/", "/moena.html"],
  ["/index.html", "/moena.html"],
  ["/manifest.webmanifest", "/moena.webmanifest"],
  ["/icons/favicon-64.png", "/icons/moena-favicon-64.png"],
  ["/icons/apple-touch-icon.png", "/icons/moena-apple-touch-icon.png"],
  ["/icons/icon-192.png", "/icons/moena-icon-192.png"],
  ["/icons/icon-512.png", "/icons/moena-icon-512.png"],
  ["/icons/icon-maskable-512.png", "/icons/moena-icon-maskable-512.png"]
]);

const NO_CACHE_PATHS = new Set([
  "/moena.html",
  "/escursioni.html",
  "/previsioni.html",
  "/offline.html",
  "/moena.webmanifest",
  "/sw.js"
]);

function textResponse(message, status, extraHeaders = {}) {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}

function resolveUpstreamUrl(requestUrl) {
  const incoming = new URL(requestUrl);
  let decodedPath;

  try {
    decodedPath = decodeURIComponent(incoming.pathname);
  } catch {
    return null;
  }

  const segments = decodedPath.split("/");
  if (
    decodedPath.includes("\\") ||
    decodedPath.includes("\0") ||
    segments.some(segment => segment === "." || segment === "..")
  ) {
    return null;
  }

  const mappedPath = PATH_ALIASES.get(decodedPath) || decodedPath;
  const relativePath = mappedPath.replace(/^\/+/, "");
  const upstream = new URL(relativePath, UPSTREAM_BASE);

  if (
    upstream.origin !== UPSTREAM_BASE.origin ||
    !upstream.pathname.startsWith(UPSTREAM_BASE.pathname)
  ) {
    return null;
  }

  upstream.search = incoming.search;
  return { incoming, mappedPath, upstream };
}

function cacheTtlFor(pathname) {
  if (NO_CACHE_PATHS.has(pathname)) return 60;
  if (/\.(?:png|webp|jpg|jpeg|svg|ico)$/i.test(pathname)) return 86400;
  return 300;
}

function browserCacheControl(pathname) {
  if (NO_CACHE_PATHS.has(pathname)) return "public, max-age=0, must-revalidate";
  if (/\.(?:png|webp|jpg|jpeg|svg|ico)$/i.test(pathname)) {
    return "public, max-age=86400";
  }
  return "public, max-age=300";
}

export default {
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return textResponse("Metodo non consentito", 405, { Allow: "GET, HEAD" });
    }

    const resolved = resolveUpstreamUrl(request.url);
    if (!resolved) return textResponse("Percorso non valido", 400);

    const requestHeaders = new Headers();
    for (const name of [
      "Accept",
      "Accept-Language",
      "If-Modified-Since",
      "If-None-Match",
      "Range"
    ]) {
      const value = request.headers.get(name);
      if (value) requestHeaders.set(name, value);
    }

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(resolved.upstream.toString(), {
        method: request.method,
        headers: requestHeaders,
        redirect: "follow",
        cf: {
          cacheEverything: true,
          cacheTtl: cacheTtlFor(resolved.mappedPath)
        }
      });
    } catch {
      return textResponse("MoenaLive è temporaneamente non disponibile", 502);
    }

    const response = new Response(upstreamResponse.body, upstreamResponse);
    response.headers.set("Cache-Control", browserCacheControl(resolved.mappedPath));
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    response.headers.set("X-MoenaLive-Proxy", "github-pages");

    if (resolved.mappedPath === "/sw.js") {
      response.headers.set("Service-Worker-Allowed", "/");
    }

    return response;
  }
};
