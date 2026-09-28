import assert from "node:assert/strict";
import worker from "./moenalive.js";

const originalFetch = globalThis.fetch;
const requests = [];

globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), init });
  const body = String(url).endsWith("/moena.html")
    ? '<head><link data-moena-manifest href="./moena.webmanifest"></head>'
    : `origine:${url}`;
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
};

try {
  const root = await worker.fetch(new Request("https://moenalive.example/"));
  assert.equal(root.status, 200);
  assert.equal(
    requests.at(-1).url,
    "https://andreavio00.github.io/meteo-fassa/moena.html"
  );
  assert.equal(root.headers.get("X-MoenaLive-Proxy"), "github-pages");
  assert.equal(root.headers.get("X-MoenaLive-Version"), "2");
  assert.match(await root.text(), /rel="manifest"/);
  assert.doesNotMatch(await (async()=>{
    const response=await worker.fetch(new Request("https://moenalive.example/"));
    return response.text();
  })(), /data-moena-manifest/);

  await worker.fetch(new Request("https://moenalive.example/index.html?test=1"));
  assert.equal(
    requests.at(-1).url,
    "https://andreavio00.github.io/meteo-fassa/moena.html?test=1"
  );

  await worker.fetch(new Request("https://moenalive.example/manifest.webmanifest"));
  assert.equal(
    requests.at(-1).url,
    "https://andreavio00.github.io/meteo-fassa/moena.webmanifest"
  );

  await worker.fetch(new Request("https://moenalive.example/icons/icon-192.png"));
  assert.equal(
    requests.at(-1).url,
    "https://andreavio00.github.io/meteo-fassa/icons/moena-icon-192.png"
  );

  await worker.fetch(new Request("https://moenalive.example/moena.js?v=14"));
  assert.equal(
    requests.at(-1).url,
    "https://andreavio00.github.io/meteo-fassa/moena.js?v=14"
  );

  const post = await worker.fetch(new Request("https://moenalive.example/", {
    method: "POST"
  }));
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("Allow"), "GET, HEAD");

  globalThis.fetch = async () => {
    throw new Error("origine non raggiungibile");
  };
  const unavailable = await worker.fetch(new Request("https://moenalive.example/"));
  assert.equal(unavailable.status, 502);

  console.log("Test MoenaLive superati");
} finally {
  globalThis.fetch = originalFetch;
}
