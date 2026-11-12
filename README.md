# cloudflare-modify-rss-feed

Serves modified copies of RSS feeds from Cloudflare Pages. Each feed is
fetched from its source, its `<channel>` metadata is edited, and the
result is served on your own domain, for example
`https://rss.stjohnsanglican.org.au/sermons`.

## Configuring feeds

Feeds are defined in the Workers KV namespace bound as `CONFIG`
(dashboard: **Storage & Databases → Workers KV → SERMONS_CONFIG → KV Pairs**).
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

The feed's `<atom:link rel="self">` and `<itunes:new-feed-url>` are always
set to the feed's own URL, worked out from the request, and can't be
overridden.

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

The Cloudflare Pages project is connected to this repository. Every push to
`main` deploys automatically. Cloudflare installs the dependencies and
bundles the function. KV settings and the custom domain are not affected by
deploys.

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
