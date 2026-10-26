// Runs the module inside a real MagicMirror (server only) and drives it from a
// browser, with a named pipe standing in for shairport-sync:
//
//   MAGICMIRROR_DIR=/path/to/MagicMirror npm run test:magicmirror
//
// MAGICMIRROR_DIR is a checkout with its dependencies installed
// (`npm ci --omit=dev`). The module is linked into its modules folder. Needs
// Playwright's Chromium and mkfifo. Not part of `npm test`.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const { chromium } = require("playwright");
const { item, classicTrack, copl } = require("../helpers");

const REPO = path.join(__dirname, "..", "..");
const MM_DIR = process.env.MAGICMIRROR_DIR;
const NAME = "MMM-ShairportMetadata";
const MODULE = "[id^=\"module_\"][id$=\"" + NAME + "\"]";

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

test("MMM-ShairportMetadata inside MagicMirror", {
	skip: MM_DIR ? false : "set MAGICMIRROR_DIR to a MagicMirror checkout with its dependencies installed",
	timeout: 240000
}, async function(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmm-shairport-mm-"));
	const fifo = path.join(dir, "metadata");
	execFileSync("mkfifo", [fifo]);
	const port = await freePort();

	const configFile = path.join(dir, "config.js");
	const config = {
		address: "127.0.0.1",
		port: port,
		ipWhitelist: [],
		language: "en",
		timeFormat: 24,
		modules: [{
			module: NAME,
			position: "bottom_left",
			header: "Now playing",
			config: { transport: "pipe", metadataPipe: fifo }
		}]
	};
	fs.writeFileSync(configFile, "let config = " + JSON.stringify(config, null, 2) + ";\nif (typeof module !== \"undefined\") { module.exports = config; }\n");

	const link = path.join(MM_DIR, "modules", NAME);
	const linked = !fs.existsSync(link);
	if (linked) { fs.symlinkSync(REPO, link, "dir"); }

	const log = [];
	const mm = spawn(process.execPath, ["serveronly"], {
		cwd: MM_DIR,
		env: Object.assign({}, process.env, { MM_CONFIG_FILE: configFile, MM_PORT: String(port) })
	});
	mm.stdout.on("data", function(d) { log.push(d.toString()); });
	mm.stderr.on("data", function(d) { log.push(d.toString()); });
	const serverLog = function() { return log.join(""); };

	let browser = null;
	let writer = null;
	const pageProblems = [];
	t.after(async function() {
		if (writer) { writer.kill(); }
		if (browser) { await browser.close(); }
		mm.kill();
		if (linked) { fs.rmSync(link, { force: true }); }
		fs.rmSync(dir, { recursive: true, force: true });
	});

	try {
		await until(function() { return /Ready to go/.test(serverLog()); }, "MagicMirror to start", 90000);
		await until(function() { return serverLog().includes("reading " + fifo); }, "the module to open the pipe");

		browser = await chromium.launch({ args: ["--no-sandbox"] });
		const page = await browser.newPage();
		page.on("pageerror", function(e) { pageProblems.push("pageerror: " + e.message); });
		await page.goto("http://127.0.0.1:" + port);

		const isHidden = function() { return page.evaluate(function(sel) { const m = document.querySelector(sel); return !!m && m.classList.contains("hidden"); }, MODULE); };
		const isShown = function() { return page.evaluate(function(sel) { const m = document.querySelector(sel); return !!m && !m.classList.contains("hidden"); }, MODULE); };
		const textOf = function(css) { return page.evaluate(function(a) { const e = document.querySelector(a[0] + " " + a[1]); return e ? e.textContent : null; }, [MODULE, css]); };
		const barValue = function() { return page.evaluate(function(sel) { const p = document.querySelector(sel + " progress"); return p ? p.value : null; }, MODULE); };
		const write = function(s) { writer.stdin.write(s, "latin1"); };

		await t.test("is hidden while nothing plays", async function() {
			await until(function() { return page.locator(MODULE + " .card").count().then(function(n) { return n === 1; }); }, "the module to create its card");
			await until(isHidden, "the idle module to be hidden");
		});

		writer = spawn("sh", ["-c", "exec cat > \"$1\"", "sh", fifo], { stdio: ["pipe", "ignore", "inherit"] });

		await t.test("a classic AirPlay track shows the card, with MagicMirror's own header", async function() {
			write(classicTrack({ title: "Halo", artist: "Beyoncé", album: "I Am...", start: 0, current: 10 * 44100, end: 200 * 44100 }));
			await until(isShown, "the card to show");
			assert.strictEqual((await textOf(".module-header")).trim(), "Now playing");
			assert.strictEqual(await textOf(".title"), "Halo");
			assert.strictEqual(await textOf(".artist"), "Beyoncé - I Am...");
			assert.ok(await page.evaluate(function(sel) { return document.querySelector(sel + " .albumart").getAttribute("src").startsWith("data:image/jpeg"); }, MODULE));
			assert.strictEqual(await page.evaluate(function(sel) { return document.querySelector(sel + " progress").max; }, MODULE), 200);
		});

		await t.test("the bar moves with the clock without the DOM being rebuilt", async function() {
			await page.evaluate(function(sel) { document.querySelector(sel + " .title").__same = true; }, MODULE);
			const before = await barValue();
			await sleep(2500);
			const after = await barValue();
			assert.ok(after - before >= 2 && after - before <= 4, "moved " + (after - before) + " s in 2.5 s");
			assert.strictEqual(await page.evaluate(function(sel) { return document.querySelector(sel + " .title").__same; }, MODULE), true);
		});

		await t.test("pause freezes the bar, resume moves it", async function() {
			write(item("ssnc", "pfls"));
			await until(async function() { return (await textOf(".time")).includes("(paused)"); }, "the paused label");
			const frozen = await barValue();
			await sleep(1500);
			assert.strictEqual(await barValue(), frozen);
			write(item("ssnc", "prsm"));
			await until(async function() { return !(await textOf(".time")).includes("(paused)"); }, "resume");
			await sleep(1500);
			assert.ok((await barValue()) > frozen);
		});

		await t.test("the end of the session hides the whole module", async function() {
			write(item("ssnc", "pend"));
			await until(isHidden, "the module to hide");
		});

		await t.test("AirPlay 2 now-playing info shows the card, and a disconnect hides it", async function() {
			write(item("ssnc", "abeg") + item("ssnc", "clip", "192.0.2.7") + item("ssnc", "copl", copl({
				ContentItemIdentifier: "ap2-1", Title: "From AirPlay 2", Artist: "Someone", Album: "Somewhere", Duration: 180,
				Timestamp: new Date(), PlaybackRate: 1, ElapsedTime: 30
			})));
			await until(isShown, "the AirPlay 2 card to show");
			assert.strictEqual(await textOf(".title"), "From AirPlay 2");
			assert.strictEqual(await textOf(".time"), "0:30 - 3:00");
			write(item("ssnc", "disc", "192.0.2.7"));
			await until(isHidden, "the module to hide after disc");
		});

		await t.test("a reloaded page shows what is playing at once", async function() {
			write(classicTrack({ title: "Halo" }));
			await until(isShown, "the card to show");
			await page.reload();
			await until(async function() { return (await isShown()) && (await textOf(".title")) === "Halo"; }, "the reloaded page to show the track");
		});

		await t.test("the sender going away hides the card", async function() {
			writer.stdin.end();
			await until(isHidden, "the module to hide when the writer closed the pipe");
		});

		await t.test("neither MagicMirror nor the page reported a problem", function() {
			const bad = serverLog().split("\n").filter(function(l) { return /Whoops|uncaught|MMM-ShairportMetadata.*(error|cannot|bad item)/i.test(l); });
			assert.deepStrictEqual(bad.concat(pageProblems), []);
		});
	} catch (err) {
		console.log("--- MagicMirror output ---\n" + serverLog().split("\n").slice(-60).join("\n"));
		throw err;
	}
});
