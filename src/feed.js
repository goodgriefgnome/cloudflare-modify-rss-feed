// Edits the <channel> metadata of an RSS feed.
//
// Only the channel "header" (everything between <channel> and the first <item>)
// is parsed and rewritten. The items are copied through byte-for-byte, which
// keeps them exactly as the source publishes them and keeps CPU time low.

import { DOMParser, XMLSerializer, onErrorStopParsing } from "@xmldom/xmldom";

const XMLNS = "http://www.w3.org/2000/xmlns/";
const ATOM = "http://www.w3.org/2005/Atom";
const ITUNES = "http://www.itunes.com/dtds/podcast-1.0.dtd";

// Namespaces that channel_tags may use even if the source feed doesn't declare them.
export const KNOWN_NAMESPACES = {
  itunes: ITUNES,
  podcast: "https://podcastindex.org/namespace/1.0",
  googleplay: "http://www.google.com/schemas/play-podcasts/1.0",
  atom: ATOM,
  content: "http://purl.org/rss/1.0/modules/content/",
  dc: "http://purl.org/dc/elements/1.1/",
};

export class FeedError extends Error {}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function parse(xml, what) {
  try {
    return new DOMParser({ onError: onErrorStopParsing }).parseFromString(xml, "text/xml");
  } catch (e) {
    throw new FeedError(`Could not parse ${what}: ${e.message}`);
  }
}

// Find the first match of `pattern` that is not inside a comment or CDATA section.
function findOutsideMarkup(xml, pattern, from = 0) {
  const re = new RegExp(`<!--[\\s\\S]*?-->|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>|${pattern}`, "g");
  re.lastIndex = from;
  let m;
  while ((m = re.exec(xml))) {
    if (!m[0].startsWith("<!--") && !m[0].startsWith("<![CDATA[")) return m;
  }
  return null;
}

// Split the source feed into: [before header] [header] [items and the rest].
function splitFeed(xml) {
  const rss = findOutsideMarkup(xml, "<rss\\b(?:[^>\"']|\"[^\"]*\"|'[^']*')*>");
  if (!rss) throw new FeedError("Source is not an RSS feed (no <rss> element)");
  const channel = findOutsideMarkup(xml, "<channel\\b(?:[^>\"']|\"[^\"]*\"|'[^']*')*>", rss.index);
  if (!channel) throw new FeedError("Source feed has no <channel>");
  const headerStart = channel.index + channel[0].length;
  const end = findOutsideMarkup(xml, "<item[\\s>/]|</channel>", headerStart);
  if (!end) throw new FeedError("Source feed's <channel> is not closed");
  return {
    rssTag: rss[0],
    rssStart: rss.index,
    channelTag: channel[0],
    headerStart,
    headerEnd: end.index,
  };
}

// Namespace declarations (prefix -> URI) on an element.
function declaredNamespaces(el) {
  const out = {};
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i];
    if (a.prefix === "xmlns") out[a.localName] = a.value;
  }
  return out;
}

// Every (prefix, URI) used by an element subtree, on elements and attributes.
function usedNamespaces(node, out = {}) {
  if (node.nodeType !== ELEMENT_NODE) return out;
  if (node.prefix && node.namespaceURI) out[node.prefix] = node.namespaceURI;
  for (let i = 0; i < node.attributes.length; i++) {
    const a = node.attributes[i];
    if (a.prefix && a.prefix !== "xmlns" && a.prefix !== "xml" && a.namespaceURI) {
      out[a.prefix] = a.namespaceURI;
    }
  }
  for (let c = node.firstChild; c; c = c.nextSibling) usedNamespaces(c, out);
  return out;
}

const key = (el) => `${el.namespaceURI ?? ""}|${el.localName}`;

function elementChildren(node) {
  const out = [];
  for (let c = node.firstChild; c; c = c.nextSibling) if (c.nodeType === ELEMENT_NODE) out.push(c);
  return out;
}

// Remove an element plus the whitespace (indentation) just before it.
function removeWithIndent(el) {
  const prev = el.previousSibling;
  if (prev && prev.nodeType === TEXT_NODE && !prev.data.trim()) prev.parentNode.removeChild(prev);
  el.parentNode.removeChild(el);
}

// An element written as <name/> with no attributes means "remove this tag".
const isDeleteMarker = (el) => el.attributes.length === 0 && !el.firstChild;

/**
 * Apply the edits to an RSS feed.
 *
 * @param {string} xml          The source feed.
 * @param {string} feedUrl      This feed's own public URL (for the self-link and itunes:new-feed-url).
 * @param {string} channelTags  XML elements to insert into <channel>, replacing existing
 *                              tags of the same name. `<name/>` on its own removes the tag.
 * @returns {string}            The modified feed.
 */
export function modifyFeed(xml, feedUrl, channelTags = "") {
  const parts = splitFeed(xml);
  const header = xml.slice(parts.headerStart, parts.headerEnd);

  // Parse the header inside its original <rss> and <channel> tags, so prefixes resolve.
  const doc = parse(`${parts.rssTag}${parts.channelTag}${header}</channel></rss>`, "source feed");
  const rss = doc.documentElement;
  const channel = elementChildren(rss)[0];
  const sourceNs = declaredNamespaces(rss);

  // Parse channel_tags, declaring the feed's namespaces plus the known ones.
  const wrapperNs = { ...KNOWN_NAMESPACES, ...sourceNs };
  const decls = Object.entries(wrapperNs).map(([p, uri]) => ` xmlns:${p}="${uri}"`).join("");
  const tagsDoc = parse(`<channel-tags${decls}>${channelTags}</channel-tags>`, "channel_tags");
  const requested = elementChildren(tagsDoc.documentElement);

  // Elements the code itself manages always go last and can't be overridden.
  const managed = [
    { ns: ITUNES, prefix: "itunes", name: "new-feed-url" },
  ];

  // 1. Remove existing channel tags that are being replaced or deleted.
  const replaceKeys = new Set(requested.map(key));
  for (const m of managed) replaceKeys.add(`${m.ns}|${m.name}`);
  for (const el of elementChildren(channel)) {
    if (replaceKeys.has(key(el))) removeWithIndent(el);
  }

  // 2. Point the self-link at this feed.
  let selfLink = elementChildren(channel).find(
    (el) => el.namespaceURI === ATOM && el.localName === "link" && el.getAttribute("rel") === "self",
  );

  // 3. Build the list of elements to insert.
  const managedKeys = new Set(managed.map((m) => `${m.ns}|${m.name}`));
  const toInsert = requested
    .filter((el) => !isDeleteMarker(el) && !managedKeys.has(key(el)))
    .map((el) => doc.importNode(el, true));
  if (selfLink) {
    selfLink.setAttribute("href", feedUrl);
  } else {
    selfLink = doc.createElementNS(ATOM, `${prefixFor(rss, ATOM, "atom")}:link`);
    selfLink.setAttribute("href", feedUrl);
    selfLink.setAttribute("rel", "self");
    selfLink.setAttribute("type", "application/rss+xml");
    toInsert.unshift(selfLink);
  }
  const newFeedUrl = doc.createElementNS(ITUNES, `${prefixFor(rss, ITUNES, "itunes")}:new-feed-url`);
  newFeedUrl.appendChild(doc.createTextNode(feedUrl));
  toInsert.push(newFeedUrl);

  // 4. Declare on <rss> any namespace the new elements need that the source doesn't.
  const addedNs = {};
  for (const el of toInsert) {
    for (const [prefix, uri] of Object.entries(usedNamespaces(el))) {
      if (sourceNs[prefix] === uri) continue;
      if (sourceNs[prefix] && sourceNs[prefix] !== uri) {
        throw new FeedError(`Prefix "${prefix}:" means something else in the source feed`);
      }
      addedNs[prefix] = uri;
    }
  }
  for (const [prefix, uri] of Object.entries(addedNs)) {
    rss.setAttributeNS(XMLNS, `xmlns:${prefix}`, uri);
  }

  // 5. Insert before the trailing whitespace, matching the header's indentation.
  const last = channel.lastChild;
  const trailing = last && last.nodeType === TEXT_NODE && !last.data.trim() ? last : null;
  const firstEl = elementChildren(channel)[0];
  const indentNode = firstEl?.previousSibling;
  const indent =
    indentNode && indentNode.nodeType === TEXT_NODE && !indentNode.data.trim() ? indentNode.data : "\n";
  for (const el of toInsert) {
    channel.insertBefore(doc.createTextNode(indent), trailing);
    channel.insertBefore(el, trailing);
  }
  if (!trailing) channel.appendChild(doc.createTextNode(indent));

  // 6. Serialise the header and splice it back into the original text.
  const serialized = new XMLSerializer().serializeToString(doc);
  const openEnd = serialized.indexOf(">", serialized.indexOf("<channel")) + 1;
  const newHeader = serialized.slice(openEnd, serialized.lastIndexOf("</channel>"));

  const extraDecls = Object.entries(addedNs)
    .map(([p, uri]) => ` xmlns:${p}="${uri}"`)
    .join("");
  const newRssTag = parts.rssTag.replace(/\s*(\/?)>$/, `${extraDecls}$1>`);

  return (
    xml.slice(0, parts.rssStart) +
    newRssTag +
    xml.slice(parts.rssStart + parts.rssTag.length, parts.headerStart) +
    newHeader +
    xml.slice(parts.headerEnd)
  );
}

// The prefix the feed already uses for a namespace, or a default one.
function prefixFor(rss, uri, fallback) {
  const found = Object.entries(declaredNamespaces(rss)).find(([, u]) => u === uri);
  return found ? found[0] : fallback;
}
