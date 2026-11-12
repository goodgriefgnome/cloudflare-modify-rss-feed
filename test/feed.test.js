import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DOMParser, onErrorStopParsing } from "@xmldom/xmldom";
import { modifyFeed, FeedError } from "../src/feed.js";

const SOURCE = readFileSync(new URL("./fixtures/sermons.xml", import.meta.url), "utf8");
const URL_ = "https://rss.example.org/sermons";

const ITUNES = "http://www.itunes.com/dtds/podcast-1.0.dtd";
const PODCAST = "https://podcastindex.org/namespace/1.0";
const ATOM = "http://www.w3.org/2005/Atom";

function channelOf(xml) {
  const doc = new DOMParser({ onError: onErrorStopParsing }).parseFromString(xml, "text/xml");
  return doc.getElementsByTagName("channel")[0];
}
const children = (channel, ns, name) =>
  Array.from(channel.childNodes).filter((n) => n.nodeType === 1 && n.namespaceURI === ns && n.localName === name);
const items = (xml) => xml.slice(xml.search(/\n\s*<item>/), xml.lastIndexOf("</channel>"));

test("no channel_tags: sets self-link and new-feed-url, leaves items untouched", () => {
  const out = modifyFeed(SOURCE, URL_, "");
  const ch = channelOf(out);

  const self = children(ch, ATOM, "link").filter((l) => l.getAttribute("rel") === "self");
  assert.equal(self.length, 1);
  assert.equal(self[0].getAttribute("href"), URL_);

  const nfu = children(ch, ITUNES, "new-feed-url");
  assert.equal(nfu.length, 1);
  assert.equal(nfu[0].textContent, URL_);

  assert.equal(items(out), items(SOURCE), "items must be byte-for-byte identical");
  assert.equal(out.slice(0, out.indexOf("<channel>")), SOURCE.slice(0, SOURCE.indexOf("<channel>")));
});

test("new tags go after the existing metadata, before the first item", () => {
  const out = modifyFeed(SOURCE, URL_, "<itunes:type>episodic</itunes:type>");
  const header = out.slice(0, out.indexOf("<item>"));
  assert.ok(header.indexOf("<itunes:type>episodic</itunes:type>") > header.indexOf("</itunes:category>"));
  assert.match(header, /\n {8}<itunes:new-feed-url>/, "keeps the feed's indentation");
});

test("replaces existing tags of the same name instead of duplicating", () => {
  const out = modifyFeed(
    SOURCE,
    URL_,
    `<itunes:summary>Weekly sermons</itunes:summary>
     <itunes:author>Someone Else</itunes:author>`,
  );
  const ch = channelOf(out);
  assert.deepEqual(children(ch, ITUNES, "summary").map((e) => e.textContent), ["Weekly sermons"]);
  assert.deepEqual(children(ch, ITUNES, "author").map((e) => e.textContent), ["Someone Else"]);
});

test("replaces nested tags as a whole (itunes:category, itunes:owner)", () => {
  const out = modifyFeed(
    SOURCE,
    URL_,
    `<itunes:category text="Religion &amp; Spirituality"><itunes:category text="Religion"/></itunes:category>
     <itunes:owner><itunes:name>Office</itunes:name><itunes:email>office@example.org</itunes:email></itunes:owner>`,
  );
  const ch = channelOf(out);
  const cats = children(ch, ITUNES, "category");
  assert.equal(cats.length, 1);
  assert.equal(cats[0].getAttribute("text"), "Religion & Spirituality");
  assert.equal(cats[0].getElementsByTagName("itunes:category")[0].getAttribute("text"), "Religion");
  const owners = children(ch, ITUNES, "owner");
  assert.equal(owners.length, 1);
  assert.equal(owners[0].getElementsByTagName("itunes:email")[0].textContent, "office@example.org");
});

test("an empty <name/> deletes the tag", () => {
  const out = modifyFeed(SOURCE, URL_, "<itunes:summary/><googleplay:description/>");
  const ch = channelOf(out);
  assert.equal(children(ch, ITUNES, "summary").length, 0);
  assert.equal(children(ch, "http://www.google.com/schemas/play-podcasts/1.0", "description").length, 0);
});

test("channel_tags can set itunes:new-feed-url", () => {
  const out = modifyFeed(
    SOURCE,
    URL_,
    `<itunes:new-feed-url>https://elsewhere.example/</itunes:new-feed-url>`,
  );
  const ch = channelOf(out);
  assert.deepEqual(children(ch, ITUNES, "new-feed-url").map((e) => e.textContent), ["https://elsewhere.example/"]);
});

test("channel_tags can remove itunes:new-feed-url", () => {
  const source = SOURCE.replace("</itunes:category>", "</itunes:category><itunes:new-feed-url>https://old.example/</itunes:new-feed-url>");
  const out = modifyFeed(source, URL_, "<itunes:new-feed-url/>");
  assert.equal(children(channelOf(out), ITUNES, "new-feed-url").length, 0);
});

test("a source new-feed-url is replaced by the default when channel_tags doesn't mention it", () => {
  const source = SOURCE.replace("</itunes:category>", "</itunes:category><itunes:new-feed-url>https://old.example/</itunes:new-feed-url>");
  const out = modifyFeed(source, URL_, "");
  assert.deepEqual(children(channelOf(out), ITUNES, "new-feed-url").map((e) => e.textContent), [URL_]);
});

test("channel_tags can set the self-link", () => {
  const out = modifyFeed(SOURCE, URL_, `<atom:link href="https://elsewhere.example/" rel="self"/>`);
  const links = children(channelOf(out), ATOM, "link");
  assert.deepEqual(links.map((l) => [l.getAttribute("rel"), l.getAttribute("href")]), [
    ["self", "https://elsewhere.example/"],
  ]);
});

test("channel_tags can remove atom:link entirely", () => {
  const out = modifyFeed(SOURCE, URL_, "<atom:link/>");
  assert.equal(children(channelOf(out), ATOM, "link").length, 0);
});

test("atom:link follows the replace-by-name rule like any other tag", () => {
  const out = modifyFeed(SOURCE, URL_, `<atom:link href="https://hub.example/" rel="hub"/>`);
  const links = children(channelOf(out), ATOM, "link");
  assert.deepEqual(links.map((l) => l.getAttribute("rel")), ["hub"], "no self-link unless listed");
});

test("declares a namespace on <rss> when a new tag needs one", () => {
  const source = SOURCE.replace(/ xmlns:podcast="[^"]*"/, "");
  const out = modifyFeed(source, URL_, "<podcast:locked>yes</podcast:locked>");
  assert.match(out.slice(0, out.indexOf("<channel>")), new RegExp(`<rss[^>]* xmlns:podcast="${PODCAST}"`));
  assert.equal(children(channelOf(out), PODCAST, "locked")[0].textContent, "yes");
  assert.ok(!/<podcast:locked xmlns/.test(out), "no repeated declaration on the element");
});

test("adds a self-link when the source has none", () => {
  const source = SOURCE.replace(/<atom:link[^>]*\/>/, "");
  const out = modifyFeed(source, URL_, "");
  const self = children(channelOf(out), ATOM, "link");
  assert.equal(self.length, 1);
  assert.equal(self[0].getAttribute("href"), URL_);
  assert.equal(self[0].getAttribute("rel"), "self");
});

test("a feed with no items still works", () => {
  const source = SOURCE.slice(0, SOURCE.indexOf("<item>")) + "</channel>\n</rss>";
  const out = modifyFeed(source, URL_, "<itunes:type>serial</itunes:type>");
  assert.equal(children(channelOf(out), ITUNES, "type")[0].textContent, "serial");
});

test("ignores '<item' inside CDATA in the header", () => {
  const source = SOURCE.replace(
    "<description><![CDATA[St John's Darlinghurst]]></description>",
    "<description><![CDATA[Not an <item> really]]></description>",
  );
  const out = modifyFeed(source, URL_, "");
  assert.equal(items(out), items(source));
  assert.match(out, /Not an <item> really/);
});

test("bad channel_tags give a clear error", () => {
  assert.throws(() => modifyFeed(SOURCE, URL_, "<itunes:type>episodic"), FeedError);
  assert.throws(() => modifyFeed(SOURCE, URL_, "<madeup:thing>x</madeup:thing>"), FeedError);
});

test("non-RSS input gives a clear error", () => {
  assert.throws(() => modifyFeed("<html><body>Not found</body></html>", URL_, ""), FeedError);
});
