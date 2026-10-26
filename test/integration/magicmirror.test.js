// Runs the module inside a real MagicMirror (server only) and drives it from a
// browser, with a named pipe (or an MQTT broker) standing in for shairport-sync:
//
//   MAGICMIRROR_DIR=/path/to/MagicMirror npm run test:magicmirror
//
// MAGICMIRROR_DIR is a checkout with its dependencies installed
// (`npm ci --omit=dev`) that is run with a Node it supports. The module is
// linked into its modules folder and a config is written into its config
// folder (MagicMirror lints its config relative to its own folder); both are
// removed afterwards. Needs Playwright's Chromium and mkfifo. Not part of
// `npm test`.
//
// PLAYWRIGHT_CHROMIUM_EXECUTABLE   another Chromium than Playwright's own
// MM_TEST_SCREENSHOTS=<dir>        save a picture of the card in each scenario
// MM_TEST_LOG=1                    print MagicMirror's output even when all passes

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const { chromium } = require("playwright");
const { Aedes } = require("aedes");
const { item, classicTrack, copl, validPng } = require("../helpers");

const REPO = path.join(__dirname, "..", "..");
const MM_DIR = process.env.MAGICMIRROR_DIR;
const NAME = "MMM-ShairportMetadata";
const MODULE = "[id^=\"module_\"][id$=\"" + NAME + "\"]";
const ART = validPng();
const decoded = function(page) {
	return page.evaluate(function(sel) { const i = document.querySelector(sel + " .albumart"); return i.complete && i.naturalWidth; }, MODULE);
};
const skip = MM_DIR ? false : "set MAGICMIRROR_DIR to a MagicMirror checkout with its dependencies installed";

function freePort() {
	return new Promise(function(resolve) {
		const s = net.createServer().listen(0, "127.0.0.1", function() {
			const port = s.address().port;
			s.close(function() { resolve(port); });
		});
	});
}

function sleep(ms) {
	return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

async function until(check, what, ms = 10000) {
	const t0 = Date.now();
	for (;;) {
		if (await check()) { return; }
		if (Date.now() - t0 > ms) { throw new Error("timed out waiting for " + what); }
		await sleep(50);
	}
}

// The module in MagicMirror's modules folder, for the whole file.
let linked = false;
test.before(function() {
	if (skip) { return; }
	const link = path.join(MM_DIR, "modules", NAME);
	if (!fs.existsSync(link)) {
		fs.symlinkSync(REPO, link, "dir");
		linked = true;
	}
});
test.after(function() {
	if (linked) { fs.rmSync(path.join(MM_DIR, "modules", NAME), { force: true }); }
});

/**
 * Starts MagicMirror with the module configured as `moduleConfig`, opens a page
 * on it and returns helpers to look at the module. Everything is stopped when
 * the test `t` ends.
 */
async function run(t, moduleConfig) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmm-shairport-mm-"));
	const port = await freePort();
	const configFile = path.join(MM_DIR, "config", "mmm-shairportmetadata-test-" + port + ".js");
	const config = {
		address: "127.0.0.1",
		port: port,
		ipWhitelist: [],
		language: "en",
		timeFormat: 24,
		modules: [{ module: NAME, position: "bottom_left", header: "Now playing", config: moduleConfig }]
	};
	fs.writeFileSync(configFile, "let config = " + JSON.stringify(config, null, 2) + ";\nif (typeof module !== \"undefined\") { module.exports = config; }\n");

	const log = [];
	const mm = spawn(process.execPath, ["serveronly"], {
		cwd: MM_DIR,
		env: Object.assign({}, process.env, { MM_CONFIG_FILE: configFile, MM_PORT: String(port) })
	});
	mm.stdout.on("data", function(d) { log.push(d.toString()); });
	mm.stderr.on("data", function(d) { log.push(d.toString()); });
	const serverLog = function() { return log.join(""); };

	let browser = null;
	let page = null;
	const pageProblems = [];
	t.after(async function() {
		if (browser) { await browser.close(); }
		mm.kill();
		fs.rmSync(configFile, { force: true });
		fs.rmSync(dir, { recursive: true, force: true });
		if (process.env.MM_TEST_LOG) { console.log("--- MagicMirror output ---\n" + serverLog()); }
	});

	try {
		await until(function() { return /Ready to go/.test(serverLog()); }, "MagicMirror to start", 90000);
		const launch = { args: ["--no-sandbox"] };
		if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) { launch.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE; }
		browser = await chromium.launch(launch);
		page = await browser.newPage({ viewport: { width: 700, height: 500 } });
		page.on("pageerror", function(e) { pageProblems.push("pageerror: " + e.message); });
		await page.goto("http://127.0.0.1:" + port);
	} catch (err) {
		console.log("--- MagicMirror output ---\n" + serverLog().split("\n").slice(-60).join("\n"));
		throw err;
	}

	return {
		page: page,
		serverLog: serverLog,
		isHidden: function() { return page.evaluate(function(sel) { const m = document.querySelector(sel); return !!m && m.classList.contains("hidden"); }, MODULE); },
		isShown: function() { return page.evaluate(function(sel) { const m = document.querySelector(sel); return !!m && !m.classList.contains("hidden"); }, MODULE); },
		textOf: function(css) { return page.evaluate(function(a) { const e = document.querySelector(a[0] + " " + a[1]); return e ? e.textContent : null; }, [MODULE, css]); },
		barValue: function() { return page.evaluate(function(sel) { const p = document.querySelector(sel + " progress"); return p ? p.value : null; }, MODULE); },
		screenshot: async function(name) {
			if (!process.env.MM_TEST_SCREENSHOTS) { return; }
			fs.mkdirSync(process.env.MM_TEST_SCREENSHOTS, { recursive: true });
			await sleep(1300); // the show animation takes a second
			await page.screenshot({ path: path.join(process.env.MM_TEST_SCREENSHOTS, name + ".png") });
		},
		problems: function() {
			const bad = serverLog().split("\n").filter(function(l) { return /Whoops|uncaught|MMM-ShairportMetadata.*(error|cannot|bad item)/i.test(l); });
			return bad.concat(pageProblems);
		}
	};
}

test("the pipe transport inside MagicMirror", { skip: skip, timeout: 240000 }, async function(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmm-shairport-fifo-"));
	t.after(function() { fs.rmSync(dir, { recursive: true, force: true }); });
	const fifo = path.join(dir, "metadata");
	execFileSync("mkfifo", [fifo]);

	const mm = await run(t, { transport: "pipe", metadataPipe: fifo });
	// the module's helper opens the pipe when the page sends it the module's config
	await until(function() { return mm.serverLog().includes("reading " + fifo); }, "the module to open the pipe");

	let writer = null;
	t.after(function() { if (writer) { writer.kill(); } });
	const newWriter = function() { writer = spawn("sh", ["-c", "exec cat > \"$1\"", "sh", fifo], { stdio: ["pipe", "ignore", "inherit"] }); };
	const write = function(s) { writer.stdin.write(s, "latin1"); };

	await t.test("is hidden while nothing plays", async function() {
		await until(function() { return mm.page.locator(MODULE + " .card").count().then(function(n) { return n === 1; }); }, "the module to create its card");
		await until(mm.isHidden, "the idle module to be hidden");
	});

	newWriter();

	await t.test("a classic AirPlay track shows the card, with MagicMirror's own header", async function() {
		write(classicTrack({ title: "Halo", artist: "Beyoncé", album: "I Am...", art: ART, start: 0, current: 10 * 44100, end: 200 * 44100 }));
		await until(mm.isShown, "the card to show");
		await until(async function() { return (await decoded(mm.page)) === 100; }, "the cover art to decode");
		assert.strictEqual((await mm.textOf(".module-header")).trim(), "Now playing");
		assert.strictEqual(await mm.textOf(".title"), "Halo");
		assert.strictEqual(await mm.textOf(".artist"), "Beyoncé - I Am...");
		assert.ok(await mm.page.evaluate(function(sel) { return document.querySelector(sel + " .albumart").getAttribute("src").startsWith("data:image/png"); }, MODULE));
		assert.strictEqual(await mm.page.evaluate(function(sel) { return document.querySelector(sel + " progress").max; }, MODULE), 200);
		await mm.screenshot("pipe-playing");
	});

	await t.test("the bar moves with the clock without the DOM being rebuilt", async function() {
		await mm.page.evaluate(function(sel) { document.querySelector(sel + " .title").__same = true; }, MODULE);
		const before = await mm.barValue();
		await sleep(2500);
		const after = await mm.barValue();
		// it updates once a second, so a 2.5 s window sees two or three ticks
		assert.ok(after - before >= 1.5 && after - before <= 3.5, "moved " + (after - before) + " s in 2.5 s");
		assert.strictEqual(await mm.page.evaluate(function(sel) { return document.querySelector(sel + " .title").__same; }, MODULE), true);
	});

	await t.test("pause freezes the bar, resume moves it", async function() {
		write(item("ssnc", "pfls"));
		await until(async function() { return (await mm.textOf(".time")).includes("(paused)"); }, "the paused label");
		await mm.screenshot("pipe-paused");
		const frozen = await mm.barValue();
		await sleep(1500);
		assert.strictEqual(await mm.barValue(), frozen);
		write(item("ssnc", "prsm"));
		await until(async function() { return !(await mm.textOf(".time")).includes("(paused)"); }, "resume");
		await sleep(1500);
		assert.ok((await mm.barValue()) > frozen);
	});

	await t.test("the end of the session hides the whole module", async function() {
		write(item("ssnc", "pend"));
		await until(mm.isHidden, "the module to hide");
	});

	await t.test("AirPlay 2 now-playing info shows the card, and a disconnect hides it", async function() {
		write(item("ssnc", "abeg") + item("ssnc", "clip", "192.0.2.7") + item("ssnc", "copl", copl({
			ContentItemIdentifier: "ap2-1", Title: "From AirPlay 2", Artist: "Someone", Album: "Somewhere", Duration: 180,
			ArtworkData: ART, Timestamp: new Date(), PlaybackRate: 1, ElapsedTime: 30
		})));
		await until(mm.isShown, "the AirPlay 2 card to show");
		await until(async function() { return (await decoded(mm.page)) === 100; }, "the AirPlay 2 cover art to decode");
		assert.strictEqual(await mm.textOf(".title"), "From AirPlay 2");
		assert.match(await mm.textOf(".time"), /^0:3[0-2] - 3:00$/);
		write(item("ssnc", "disc", "192.0.2.7"));
		await until(mm.isHidden, "the module to hide after disc");
	});

	await t.test("a reloaded page shows what is playing at once", async function() {
		write(classicTrack({ title: "Halo" }));
		await until(mm.isShown, "the card to show");
		await mm.page.reload();
		await until(async function() { return (await mm.isShown()) && (await mm.textOf(".title")) === "Halo"; }, "the reloaded page to show the track");
	});

	await t.test("the sender going away hides the card", async function() {
		writer.stdin.end();
		await until(mm.isHidden, "the module to hide when the writer closed the pipe");
	});

	await t.test("a new sender after the old one left is picked up again", async function() {
		const readings = function() { return mm.serverLog().split("reading " + fifo).length - 1; };
		const before = readings();
		await until(function() { return readings() > before; }, "the module to open the pipe again", 15000);
		newWriter();
		write(classicTrack({ title: "Second sender" }));
		await until(async function() { return (await mm.isShown()) && (await mm.textOf(".title")) === "Second sender"; }, "the second sender's track");
	});

	await t.test("neither MagicMirror nor the page reported a problem", function() {
		assert.deepStrictEqual(mm.problems(), []);
	});
});

test("the MQTT transport inside MagicMirror", { skip: skip, timeout: 240000 }, async function(t) {
	const broker = await Aedes.createBroker();
	const server = net.createServer(broker.handle);
	const sockets = new Set();
	server.on("connection", function(sock) {
		sockets.add(sock);
		sock.on("close", function() { sockets.delete(sock); });
	});
	let subscriptions = 0;
	broker.on("subscribe", function() { subscriptions++; });
	await new Promise(function(resolve) { server.listen(0, "127.0.0.1", resolve); });
	t.after(async function() {
		sockets.forEach(function(sock) { sock.destroy(); });
		await new Promise(function(resolve) { server.close(resolve); });
		await new Promise(function(resolve) { broker.close(resolve); });
	});
	const url = "mqtt://127.0.0.1:" + server.address().port;
	const publish = function(topic, payload) {
		return new Promise(function(resolve) {
			broker.publish({ cmd: "publish", qos: 0, retain: false, dup: false, topic: "shairport/" + topic, payload: Buffer.from(payload) }, resolve);
		});
	};

	const mm = await run(t, { transport: "mqtt", mqttUrl: url, mqttTopic: "shairport" });
	await until(function() { return mm.serverLog().includes("connected to " + url) && subscriptions > 0; }, "the module to connect to the broker and subscribe");

	await t.test("is hidden while nothing plays", async function() {
		await until(mm.isHidden, "the idle module to be hidden");
	});

	await t.test("a track published to the raw topics shows the card", async function() {
		await publish("ssnc/pbeg", "");
		await publish("core/asar", "Artist");
		await publish("core/minm", "Over MQTT");
		await publish("ssnc/PICT", ART);
		await publish("ssnc/prgr", "0/" + (10 * 44100) + "/" + (200 * 44100));
		await publish("ssnc/pffr", "");
		await until(mm.isShown, "the card to show");
		assert.strictEqual(await mm.textOf(".title"), "Over MQTT");
		assert.match(await mm.textOf(".time"), /^0:1[0-2] - 3:20$/);
		await until(async function() { return (await decoded(mm.page)) === 100; }, "the cover art to decode");
		await mm.screenshot("mqtt-playing");
	});

	await t.test("AirPlay 2 now-playing info arrives as a binary payload, and a disconnect hides the card", async function() {
		await publish("ssnc/clip", "192.0.2.9");
		await publish("ssnc/copl", copl({
			ContentItemIdentifier: "ap2-mqtt", Title: "AirPlay 2 over MQTT", Artist: "Someone", Duration: 120,
			Timestamp: new Date(), PlaybackRate: 1, ElapsedTime: 5
		}));
		await until(async function() { return (await mm.textOf(".title")) === "AirPlay 2 over MQTT"; }, "the AirPlay 2 title");
		await publish("ssnc/disc", "192.0.2.9");
		await until(mm.isHidden, "the module to hide after disc");
	});

	await t.test("neither MagicMirror nor the page reported a problem", function() {
		assert.deepStrictEqual(mm.problems(), []);
	});
});
