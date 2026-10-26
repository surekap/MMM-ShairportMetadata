// Loads the real MMM-ShairportMetadata.js into Chromium with a minimal stand-in
// for MagicMirror's Module, and drives it with the states node_helper sends.
//
// Needs Playwright's Chromium (`npx playwright install chromium`). Without it the
// tests are skipped, unless CI is set, where a missing browser is a failure.
// PLAYWRIGHT_CHROMIUM_EXECUTABLE points at another Chromium.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const { validPng } = require("./helpers");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "MMM-ShairportMetadata.js"), "utf8");

const STUBS = `
window.Log = { info: function() {}, log: function() {} };
window.Module = { register: function(name, definition) { window.__definition = definition; } };
// the module's one-second timer, driven by hand
window.__timers = [];
window.setInterval = function(fn) { window.__timers.push(fn); return window.__timers.length; };
window.clearInterval = function(id) { if (id) { window.__timers[id - 1] = null; } };
window.tickTimer = function() { window.__timers.forEach(function(fn) { if (fn) { fn(); } }); };
window.liveTimers = function() { return window.__timers.filter(Boolean).length; };

// An instance of the module with MagicMirror's methods faked and a clock we control
window.create = function(config) {
	var calls = { sent: [], shows: [], hides: [] };
	var clock = { t: 1000 };
	var m = Object.assign({}, window.__definition, {
		name: "MMM-ShairportMetadata",
		identifier: "module_7_MMM-ShairportMetadata",
		data: { header: "Now playing" },
		config: Object.assign({}, window.__definition.defaults, config || {}),
		sendSocketNotification: function(n, p) { calls.sent.push([n, p]); },
		show: function(speed, cb, opts) { calls.shows.push([speed, opts]); },
		hide: function(speed, cb, opts) { calls.hides.push([speed, opts]); },
		now: function() { return clock.t; }
	});
	window.m = m; window.calls = calls; window.clock = clock;
	m.start();
	document.body.appendChild(m.getDom());
	m.notificationReceived("DOM_OBJECTS_CREATED");
	return m;
};
window.state = function(extra) {
	return Object.assign({ state: "playing", title: "Halo", artist: "Beyoncé", album: "I Am...", duration: 200, position: 10, rate: 1 }, extra || {});
};
`;

let playwright;
let browser;
let skip = false;

test.before(async function() {
	try {
		playwright = require("playwright");
		const options = {};
		if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) { options.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE; }
		browser = await playwright.chromium.launch(options);
	} catch (err) {
		if (process.env.CI) { throw err; }
		skip = "Playwright's Chromium is not available: " + err.message.split("\n")[0];
	}
});

test.after(async function() {
	if (browser) { await browser.close(); }
});

async function open() {
	const page = await browser.newPage();
	await page.setContent("<!doctype html><html><body></body></html>");
	await page.addScriptTag({ content: STUBS });
	await page.addScriptTag({ content: SOURCE });
	return page;
}

function browserTest(name, body) {
	test(name, async function(t) {
		if (skip) { return t.skip(skip); }
		const page = await open();
		try { await body(page); } finally { await page.close(); }
	});
}

browserTest("asks node_helper for data with its config, defaults filled in", async function(page) {
	const sent = await page.evaluate(function() { create({ alignment: "left" }); return window.calls.sent; });
	assert.strictEqual(sent.length, 1);
	assert.strictEqual(sent[0][0], "CONFIG");
	assert.deepStrictEqual(sent[0][1], {
		transport: "pipe", metadataPipe: "/tmp/shairport-sync-metadata", mqttUrl: "mqtt://localhost:1883",
		mqttTopic: "shairport", alignment: "left", hideAfter: 0, sampleRate: 44100
	});
});

browserTest("starts hidden, and stays hidden until something plays", async function(page) {
	const r = await page.evaluate(function() {
		create();
		return { hides: window.calls.hides, shows: window.calls.shows, timers: liveTimers() };
	});
	assert.deepStrictEqual(r.hides, [[0, { lockString: "module_7_MMM-ShairportMetadata" }]]);
	assert.deepStrictEqual(r.shows, []);
	assert.strictEqual(r.timers, 0);
});

browserTest("a playing state shows the card with title, artist - album, art, progress and times", async function(page) {
	const r = await page.evaluate(function() {
		create();
		m.socketNotificationReceived("STATE", state({ artwork: "data:image/png;base64,iVBORw0KGgo=" }));
		var d = document;
		return {
			title: d.querySelector(".title").textContent,
			artist: d.querySelector(".artist").textContent,
			src: d.querySelector(".albumart").getAttribute("src"),
			max: d.querySelector("progress").max, value: d.querySelector("progress").value,
			time: d.querySelector(".time").textContent,
			shows: window.calls.shows, timers: liveTimers()
		};
	});
	assert.strictEqual(r.title, "Halo");
	assert.strictEqual(r.artist, "Beyoncé - I Am...");
	assert.strictEqual(r.src, "data:image/png;base64,iVBORw0KGgo=");
	assert.strictEqual(r.max, 200);
	assert.strictEqual(r.value, 10);
	assert.strictEqual(r.time, "0:10 - 3:20");
	assert.deepStrictEqual(r.shows, [[1000, { lockString: "module_7_MMM-ShairportMetadata" }]]);
	assert.strictEqual(r.timers, 1);
});

browserTest("the bar and the times move with the clock, in place, without rebuilding the DOM", async function(page) {
	const r = await page.evaluate(function() {
		create();
		m.socketNotificationReceived("STATE", state());
		var before = { dom: m.getDom(), title: document.querySelector(".title"), bar: document.querySelector("progress") };
		var mutations = 0;
		// swapping the text inside an element is expected; adding or removing elements is a rebuild
		var elements = function(nodes) { return Array.prototype.filter.call(nodes, function(n) { return n.nodeType === 1; }).length; };
		new MutationObserver(function(list) { list.forEach(function(x) { mutations += elements(x.addedNodes) + elements(x.removedNodes); }); })
			.observe(document.body, { childList: true, subtree: true });
		var seen = [];
		for (var i = 0; i < 5; i++) {
			clock.t += 1; tickTimer();
			seen.push([document.querySelector("progress").value, document.querySelector(".time").textContent]);
		}
		// time passes between ticks too: the bar follows the clock, not the number of renders
		clock.t += 30; tickTimer();
		seen.push([document.querySelector("progress").value, document.querySelector(".time").textContent]);
		return new Promise(function(resolve) {
			setTimeout(function() {
				resolve({
					seen: seen, mutations: mutations,
					sameDom: m.getDom() === before.dom, sameTitle: document.querySelector(".title") === before.title,
					sameBar: document.querySelector("progress") === before.bar
				});
			}, 0);
		});
	});
	assert.deepStrictEqual(r.seen, [[11, "0:11 - 3:20"], [12, "0:12 - 3:20"], [13, "0:13 - 3:20"], [14, "0:14 - 3:20"], [15, "0:15 - 3:20"], [45, "0:45 - 3:20"]]);
	assert.strictEqual(r.mutations, 0, "no element added or removed while ticking");
	assert.ok(r.sameDom && r.sameTitle && r.sameBar);
});

browserTest("a new state re-anchors the bar; repeated renders do not advance it", async function(page) {
	const r = await page.evaluate(function() {
		create();
		m.socketNotificationReceived("STATE", state({ position: 100 }));
		for (var i = 0; i < 50; i++) { m.update(); }
		var afterManyRenders = document.querySelector("progress").value;
		clock.t += 20;
		m.socketNotificationReceived("STATE", state({ position: 20 })); // seek back
		return [afterManyRenders, document.querySelector("progress").value];
	});
	assert.deepStrictEqual(r, [100, 20]);
});

browserTest("the position stops at the end of the track", async function(page) {
	const r = await page.evaluate(function() {
		create();
		m.socketNotificationReceived("STATE", state({ position: 195 }));
		clock.t += 60; tickTimer();
		return [document.querySelector("progress").value, document.querySelector(".time").textContent];
	});
	assert.deepStrictEqual(r, [200, "3:20 - 3:20"]);
});

browserTest("paused: the bar stands still and says so; resuming moves it again", async function(page) {
	const r = await page.evaluate(function() {
		create();
		m.socketNotificationReceived("STATE", state({ state: "paused", rate: 0, position: 42 }));
		clock.t += 500; tickTimer();
		var paused = [document.querySelector("progress").value, document.querySelector(".time").textContent];
		m.socketNotificationReceived("STATE", state({ position: 42 }));
		clock.t += 8; tickTimer();
		var resumed = [document.querySelector("progress").value, document.querySelector(".time").textContent];
		return { paused: paused, resumed: resumed };
	});
	assert.deepStrictEqual(r.paused, [42, "0:42 - 3:20 (paused)"]);
	assert.deepStrictEqual(r.resumed, [50, "0:50 - 3:20"]);
});

browserTest("stopped hides the whole module and stops the timer, and leaves the header alone", async function(page) {
	const r = await page.evaluate(function() {
		create();
		m.socketNotificationReceived("STATE", state());
		m.socketNotificationReceived("STATE", { state: "stopped" });
		return { hides: window.calls.hides, timers: liveTimers(), header: m.data.header };
	});
	assert.deepStrictEqual(r.hides.pop(), [1000, { lockString: "module_7_MMM-ShairportMetadata" }]);
	assert.strictEqual(r.timers, 0);
	assert.strictEqual(r.header, "Now playing", "the header is MagicMirror's, not the module's");
});

browserTest("showing again after a stop works, with a single timer", async function(page) {
	const r = await page.evaluate(function() {
		create();
		m.socketNotificationReceived("STATE", state());
		m.socketNotificationReceived("STATE", { state: "stopped" });
		m.socketNotificationReceived("STATE", state({ title: "Next" }));
		return { title: document.querySelector(".title").textContent, shows: window.calls.shows.length, timers: liveTimers() };
	});
	assert.deepStrictEqual(r, { title: "Next", shows: 2, timers: 1 });
});

browserTest("a state before MagicMirror has created the DOM is applied once it has", async function(page) {
	const r = await page.evaluate(function() {
		var def = window.__definition;
		var calls = { shows: [], hides: [] };
		var m = Object.assign({}, def, {
			identifier: "x", config: Object.assign({}, def.defaults), sendSocketNotification: function() {},
			show: function(s) { calls.shows.push(s); }, hide: function(s) { calls.hides.push(s); }
		});
		m.start();
		m.socketNotificationReceived("STATE", state());
		var early = { shows: calls.shows.length, hides: calls.hides.length };
		document.body.appendChild(m.getDom());
		m.notificationReceived("DOM_OBJECTS_CREATED");
		return { early: early, title: document.querySelector(".title").textContent, shows: calls.shows.length };
	});
	assert.deepStrictEqual(r.early, { shows: 0, hides: 0 });
	assert.strictEqual(r.title, "Halo");
	assert.strictEqual(r.shows, 1);
});

browserTest("hideAfter hides a card that has been paused that long", async function(page) {
	const r = await page.evaluate(function() {
		create({ hideAfter: 60 });
		m.socketNotificationReceived("STATE", state({ state: "paused", rate: 0 }));
		clock.t += 59; tickTimer();
		var before = window.calls.hides.length;
		clock.t += 2; tickTimer();
		return { before: before, after: window.calls.hides.length, timers: liveTimers() };
	});
	assert.strictEqual(r.after, r.before + 1);
	assert.strictEqual(r.timers, 0);
});

browserTest("with hideAfter 0 a paused card stays", async function(page) {
	const hidden = await page.evaluate(function() {
		create({ hideAfter: 0 });
		m.socketNotificationReceived("STATE", state({ state: "paused", rate: 0 }));
		var before = window.calls.hides.length;
		clock.t += 3600 * 5; tickTimer();
		return window.calls.hides.length - before;
	});
	assert.strictEqual(hidden, 0);
});

browserTest("playing 2 minutes past the end of the track with no news hides the card", async function(page) {
	const r = await page.evaluate(function() {
		create();
		m.socketNotificationReceived("STATE", state({ position: 190 }));
		clock.t += 10 + 100; tickTimer(); // 100 s past the end: still waiting for news
		var before = window.calls.hides.length;
		clock.t += 30; tickTimer();       // 130 s past the end
		return window.calls.hides.length - before;
	});
	assert.strictEqual(r, 1);
});

browserTest("no duration (a live stream): no bar and no times", async function(page) {
	const r = await page.evaluate(function() {
		create();
		m.socketNotificationReceived("STATE", state({ duration: 0, position: 12 }));
		return { bar: document.querySelector("progress").hidden, time: document.querySelector(".time").hidden };
	});
	assert.deepStrictEqual(r, { bar: true, time: true });
});

browserTest("text from the sender is shown as text, never as markup", async function(page) {
	const r = await page.evaluate(function() {
		create();
		var scriptsBefore = document.querySelectorAll("script").length;
		var evil = "<img src=x onerror=\"window.__pwned=1\"><b>bold</b>";
		m.socketNotificationReceived("STATE", state({ title: evil, artist: evil, album: "<script>window.__pwned=2</script>" }));
		return new Promise(function(resolve) {
			setTimeout(function() {
				resolve({
					title: document.querySelector(".title").textContent, titleHtmlChildren: document.querySelector(".title").children.length,
					images: document.images.length, bolds: document.querySelectorAll("b").length,
					scriptsAdded: document.querySelectorAll("script").length - scriptsBefore,
					pwned: window.__pwned
				});
			}, 50);
		});
	});
	assert.strictEqual(r.title, "<img src=x onerror=\"window.__pwned=1\"><b>bold</b>");
	assert.strictEqual(r.titleHtmlChildren, 0);
	assert.strictEqual(r.images, 1, "only the album art element");
	assert.strictEqual(r.bolds, 0);
	assert.strictEqual(r.scriptsAdded, 0);
	assert.strictEqual(r.pwned, undefined);
});

browserTest("artwork is kept when a state does not mention it, and removed when it is null", async function(page) {
	const r = await page.evaluate(function() {
		create();
		m.socketNotificationReceived("STATE", state({ artwork: "data:image/png;base64,AAAA" }));
		var a = document.querySelector(".albumart").getAttribute("src");
		m.socketNotificationReceived("STATE", state({ position: 20 }));
		var b = document.querySelector(".albumart").getAttribute("src");
		m.socketNotificationReceived("STATE", state({ artwork: null }));
		var c = document.querySelector(".albumart").getAttribute("src");
		return [a, b, c];
	});
	assert.deepStrictEqual(r, ["data:image/png;base64,AAAA", "data:image/png;base64,AAAA", null]);
});

browserTest("artwork the browser cannot decode is hidden, not shown as a broken image, and not retried", async function(page) {
	const bad = "data:image/png;base64,AAAA";
	await page.evaluate(function(b) { create(); m.socketNotificationReceived("STATE", state({ artwork: b })); }, bad);
	await page.waitForFunction(function() { return !document.querySelector(".albumart").hasAttribute("src"); });
	const r = await page.evaluate(function(b) {
		var has = function() { return document.querySelector(".albumart").hasAttribute("src"); };
		m.socketNotificationReceived("STATE", state({ position: 30 }));   // the same artwork, not mentioned
		var unmentioned = has();
		m.socketNotificationReceived("STATE", state({ artwork: b }));     // the same bad artwork again
		return { unmentioned: unmentioned, again: has() };
	}, bad);
	assert.deepStrictEqual(r, { unmentioned: false, again: false });
});

browserTest("artwork that decodes is shown at its size", async function(page) {
	const png = "data:image/png;base64," + validPng().toString("base64");
	await page.evaluate(function(p) { create(); m.socketNotificationReceived("STATE", state({ artwork: p })); }, png);
	await page.waitForFunction(function() { var i = document.querySelector(".albumart"); return i.complete && i.naturalWidth > 0; });
	const natural = await page.evaluate(function() { return document.querySelector(".albumart").naturalWidth; });
	assert.strictEqual(natural, 100);
});

browserTest("alignment: left, right, anything else is center", async function(page) {
	const r = await page.evaluate(function() {
		return ["left", "right", "center", "sideways"].map(function(a) {
			document.body.innerHTML = "";
			create({ alignment: a });
			return m.getDom().style.textAlign;
		});
	});
	assert.deepStrictEqual(r, ["left", "right", "center", "center"]);
});

browserTest("a notification that is not STATE is ignored", async function(page) {
	const r = await page.evaluate(function() {
		create();
		m.socketNotificationReceived("DATA", state());
		return window.calls.shows.length;
	});
	assert.strictEqual(r, 0);
});
