const test = require("node:test");
const assert = require("node:assert");
const { PipeParser } = require("../transports");
const { item, classicTrack, JPEG } = require("./helpers");

function collect() {
	const out = { items: [], errors: [] };
	out.parser = new PipeParser(
		function(type, code, data) { out.items.push({ code: type + "/" + code, data: data }); },
		function(err) { out.errors.push(err.message); }
	);
	return out;
}

test("reads items with and without data", function() {
	const c = collect();
	c.parser.write(item("ssnc", "pbeg") + item("core", "minm", "Song") + item("ssnc", "PICT", JPEG));
	assert.deepStrictEqual(c.errors, []);
	assert.deepStrictEqual(c.items.map(function(i) { return i.code; }), ["ssnc/pbeg", "core/minm", "ssnc/PICT"]);
	assert.strictEqual(c.items[0].data.length, 0);
	assert.strictEqual(c.items[1].data.toString(), "Song");
	assert.deepStrictEqual(c.items[2].data, JPEG);
});

test("gives the same result however the stream is cut into chunks", function() {
	const stream = classicTrack() + item("core", "minm", "Beyoncé – Halo ♪") + item("ssnc", "pend");
	const whole = collect();
	whole.parser.write(stream);
	for (const size of [1, 2, 7, 64, 1000]) {
		const c = collect();
		for (let i = 0; i < stream.length; i += size) { c.parser.write(stream.slice(i, i + size)); }
		assert.deepStrictEqual(c.errors, [], "chunk size " + size);
		assert.deepStrictEqual(c.items, whole.items, "chunk size " + size);
	}
	assert.strictEqual(whole.items.length, 10);
});

test("keeps non-ASCII text intact", function() {
	const c = collect();
	c.parser.write(item("core", "minm", "Beyoncé – Halo ♪"));
	assert.strictEqual(c.items[0].data.toString("utf8"), "Beyoncé – Halo ♪");
});

test("tolerates base64 wrapped over several lines and other whitespace", function() {
	const c = collect();
	const b64 = Buffer.from("A long enough title to wrap").toString("base64");
	c.parser.write(
		"<item><type>636f7265</type><code>6d696e6d</code><length>27</length>\r\n" +
		"<data encoding=\"base64\">\r\n" + b64.slice(0, 10) + "\r\n" + b64.slice(10) + "\r\n</data>\r\n</item>\r\n");
	assert.deepStrictEqual(c.errors, []);
	assert.strictEqual(c.items[0].data.toString(), "A long enough title to wrap");
});

test("skips a malformed item, reports it, and carries on", function() {
	const c = collect();
	c.parser.write(
		item("core", "asar", "Artist") +
		"<item><type>zzzz</type><code>6d696e6d</code><length>1</length></item>\n" +
		item("core", "minm", "Song"));
	assert.strictEqual(c.errors.length, 1);
	assert.match(c.errors[0], /malformed item/);
	assert.deepStrictEqual(c.items.map(function(i) { return i.data.toString(); }), ["Artist", "Song"]);
});

test("rejects data whose length differs from the announced one", function() {
	const c = collect();
	c.parser.write(
		"<item><type>636f7265</type><code>6d696e6d</code><length>99</length>\n<data encoding=\"base64\">\nU29uZw==</data></item>\n" +
		item("core", "asal", "Album"));
	assert.strictEqual(c.errors.length, 1);
	assert.match(c.errors[0], /core\/minm: length 99 announced, 4 bytes/);
	assert.deepStrictEqual(c.items.map(function(i) { return i.code; }), ["core/asal"]);
});

test("joining the stream half way through an item is not an error", function() {
	const c = collect();
	const whole = item("core", "minm", "Song");
	c.parser.write(whole.slice(40) + item("core", "asar", "Artist"));
	assert.deepStrictEqual(c.errors, []);
	assert.deepStrictEqual(c.items.map(function(i) { return i.code; }), ["core/asar"]);
});

test("an error in the consumer is reported and does not stop the stream", function() {
	const errors = [];
	const seen = [];
	const parser = new PipeParser(function(type, code) {
		seen.push(code);
		if (code === "minm") { throw new Error("consumer broke"); }
	}, function(err) { errors.push(err.message); });
	parser.write(item("core", "minm", "Song") + item("core", "asar", "Artist"));
	assert.deepStrictEqual(errors, ["consumer broke"]);
	assert.deepStrictEqual(seen, ["minm", "asar"]);
});

test("drops a stream that never ends an item instead of growing without bound", function() {
	const c = collect();
	const junk = "x".repeat(1024 * 1024);
	for (let i = 0; i < 33; i++) { c.parser.write(junk); }
	assert.strictEqual(c.errors.length, 1);
	assert.match(c.errors[0], /no end of item/);
	c.parser.write(item("core", "minm", "Song"));
	assert.strictEqual(c.items.length, 1);
});

test("reset forgets a half-read item", function() {
	const c = collect();
	c.parser.write(item("core", "minm", "Song").slice(0, 50));
	c.parser.reset();
	c.parser.write(item("core", "asar", "Artist"));
	assert.deepStrictEqual(c.errors, []);
	assert.deepStrictEqual(c.items.map(function(i) { return i.code; }), ["core/asar"]);
});
