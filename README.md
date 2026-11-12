# cloudflare-modify-rss-feed

Serves modified copies of RSS feeds from Cloudflare Pages. Each feed is
fetched from its source, its `<channel>` metadata is edited, and the
result is served on your own domain, for example
`https://rss.stjohnsanglican.org.au/sermons`.

## Configuring feeds

Feeds are defined in the Workers KV namespace bound as `CONFIG`
(dashboard: **Storage & Databases → Workers KV → MODIFY_RSS_FEED_CONFIG → KV Pairs**).
Changes take effect within about a minute, with no redeploy.

| Key | Required | Meaning |
|---|---|---|
| `<feed>:source_url` | yes | The RSS feed to copy. Serves `/<feed>`. |
| `<feed>:channel_tags` | no | XML elements to put in `<channel>`. |

`<feed>` may contain lowercase letters, digits and dashes. A path with no
`source_url` key returns 404.

### How `channel_tags` works

- Each element replaces **every** existing `<channel>` element with the same
  name, or is added if there is none.
- An empty `<name/>` with no attributes removes that element.
- Only the channel metadata is changed, never the `<item>`s.
- Common podcast prefixes (`itunes:`, `podcast:`, `googleplay:`, `atom:`,
  `content:`, `dc:`) can be used even if the source feed doesn't declare them.
- Escape `&` as `&amp;`.

Example:

```xml
<itunes:summary>Weekly sermons from St John's Darlinghurst.</itunes:summary>
<itunes:type>episodic</itunes:type>
<googleplay:description/>
```

### Defaults

If `channel_tags` doesn't mention `atom:link` or `itunes:new-feed-url`, these
defaults are added to it, using the feed's own URL worked out from the
request (e.g. `https://rss.stjohnsanglican.org.au/sermons`):

```xml
<atom:link href="{feed URL}" rel="self" type="application/rss+xml"/>
<itunes:new-feed-url>{feed URL}</itunes:new-feed-url>
```

They then follow the same rule as any other tag. To override one, list that
tag yourself. For example, listing an `<atom:link rel="hub" …/>` replaces the
default and every existing `atom:link`, so include the self-link too if you
want one. `<itunes:new-feed-url/>` removes that tag.

If the source feed or `channel_tags` can't be parsed, the URL returns a 500
error with a message explaining why.

## How it works

- `functions/[feed].js` handles `/<feed>`: it reads the settings from KV,
  fetches the source, calls `modifyFeed`, and caches the result for 15
  minutes. The cache key includes the settings, so edits apply immediately.
- `src/feed.js` (`modifyFeed`) parses only the channel header (everything
  before the first `<item>`) with [@xmldom/xmldom](https://github.com/xmldom/xmldom),
  edits it, and splices it back. Items are copied byte-for-byte, and the CPU
  cost stays well under Cloudflare's free-plan limit.

## Deployment

The Cloudflare Pages project `modify-rss-feed` is connected to this
repository. Every push to `main` deploys automatically. Cloudflare installs
the dependencies, runs the build command, and bundles the function. KV
settings and the custom domain are not affected by deploys.

Project build settings (dashboard: **Settings → Build**):

- **Build command:** `npm test`. If the tests fail, the deploy is aborted.
  Some build command must be set: with none, Cloudflare skips installing
  dependencies and the function can't find `@xmldom/xmldom`.
- **Build output directory:** `public` (also set in `wrangler.jsonc`).

`wrangler.jsonc` holds the project name and the KV binding.

## Development

```bash
npm install
```

```bash
npm test
```

To run it locally, use `npx wrangler pages dev`, with local KV entries set via
`npx wrangler kv key put --local --namespace-id=<id> <key> <value>`.
