// Serves https://<host>/<feed> for every feed defined in the CONFIG KV namespace:
//
//   <feed>:source_url     the RSS feed to copy (required; without it the path is a 404)
//   <feed>:channel_tags   optional XML to put in <channel>, replacing tags of the same name

import { modifyFeed, FeedError } from "../src/feed.js";

const CACHE_SECONDS = 900; // 15 minutes
const FEED_NAME = /^[a-z0-9][a-z0-9-]*$/;

async function shortHash(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const notFound = () => new Response("Not found", { status: 404 });

export async function onRequestGet({ request, env, params, waitUntil }) {
  const name = params.feed;
  if (!FEED_NAME.test(name)) return notFound();
  if (!env.CONFIG) return new Response("KV binding CONFIG is missing", { status: 500 });

  const [source, tags] = await Promise.all([
    env.CONFIG.get(`${name}:source_url`),
    env.CONFIG.get(`${name}:channel_tags`),
  ]);
  if (!source) return notFound();

  // This feed's own public URL, worked out from the request.
  const feedUrl = `${new URL(request.url).origin}/${name}`;

  // The cache key includes a hash of the settings, so editing them takes effect at once.
  const cacheKey = new Request(`${feedUrl}?v=${await shortHash(`${source}\n${tags ?? ""}`)}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const upstream = await fetch(source, { headers: { "User-Agent": "cloudflare-modify-rss-feed" } });
  if (!upstream.ok) {
    return new Response(`Source feed returned HTTP ${upstream.status}`, { status: 502 });
  }

  let body;
  try {
    body = modifyFeed(await upstream.text(), feedUrl, tags ?? "");
  } catch (e) {
    if (e instanceof FeedError) return new Response(`Feed error: ${e.message}`, { status: 500 });
    throw e;
  }

  const response = new Response(body, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
    },
  });
  waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

export const onRequestHead = onRequestGet;
