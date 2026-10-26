// Runs openPipe against a real named pipe with a separate process as the
// writer, the way shairport-sync is. Needs mkfifo (Linux, macOS).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const { openPipe } = require("../transports");
const { item, waitFor, JPEG } = require("./helpers");

const FAST = { minDelay: 20, maxDelay: 40, watchMs: 50 };

function mkfifo(file) {
	execFileSync("mkfifo", [file]);
}

let canMkfifo = true;
try {
	const probe = fs.mkdtempSync(path.join(os.tmpdir(), "mmm-probe-"));
	mkfifo(path.join(probe, "p"));
	fs.rmSync(probe, { recursive: true, force: true });
} catch (err) {
	canMkfifo = false;
}

function setup(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmm-shairport-"));
	const seen = { messages: [], ends: 0, logs: [] };
	const handlers = {
		onMessage: function(code, payload) { seen.messages.push([code, payload]); },
		onEnd: function() { seen.ends++; },
		log: function(message) { seen.logs.push(message); }
	};
	const writers = [];
	const readers = [];
	t.after(function() {
		readers.forEach(function(r) { r.close(); });
		writers.forEach(function(w) { w.kill(); });
		fs.rmSync(dir, { recursive: true, force: true });
	});
	return {
		fifo: path.join(dir, "metadata"),
		seen: seen,
		open: function(file, opts) {
			const reader = openPipe(file, handlers, opts || FAST);
			readers.push(reader);
			return reader;
		},
		// a separate process, like shairport-sync: it blocks until a reader has the pipe open
		writer: function(file) {
			const child = spawn("sh", ["-c", "exec cat > \"$1\"", "sh", file], { stdio: ["pipe", "ignore", "inherit"] });
			writers.push(child);
			return {
				write: function(s) { child.stdin.write(s, "latin1"); },
				end: function() {
					return new Promise(function(resolve) {
						child.on("close", resolve);
						child.stdin.end();
					});
				}
			};
		}
	};
}

const opts = { skip: canMkfifo ? false : "mkfifo is not available" };

function readings(h) {
	return h.seen.logs.filter(function(l) { return l.startsWith("reading "); }).length;
}

test("delivers the items a separate process writes into the pipe", opts, async function(t) {
	const h = setup(t);
	mkfifo(h.fifo);
	h.open(h.fifo);
	await waitFor(function() { return h.seen.logs.some(function(l) { return l.startsWith("reading "); }); });
	const w = h.writer(h.fifo);
	w.write(item("ssnc", "pbeg") + item("core", "minm", "Song") + item("ssnc", "PICT", JPEG));
	await waitFor(function() { return h.seen.messages.length === 3; });
	assert.deepStrictEqual(h.seen.messages.map(function(m) { return m[0]; }), ["ssnc/pbeg", "core/minm", "ssnc/PICT"]);
	assert.strictEqual(h.seen.messages[1][1].toString(), "Song");
	assert.deepStrictEqual(h.seen.messages[2][1], JPEG);
});

test("a 3 MB cover art arrives intact through the pipe's 64 KB buffer", opts, async function(t) {
	const h = setup(t);
	mkfifo(h.fifo);
	h.open(h.fifo);
	await waitFor(function() { return h.seen.logs.some(function(l) { return l.startsWith("reading "); }); });
	const art = Buffer.alloc(3 * 1024 * 1024);
	for (let i = 0; i < art.length; i++) { art[i] = (i * 31) & 0xff; }
	const w = h.writer(h.fifo);
	w.write(item("ssnc", "PICT", art) + item("ssnc", "mden"));
	await waitFor(function() { return h.seen.messages.length === 2; }, 10000);
	assert.ok(h.seen.messages[0][1].equals(art));
});

test("opening does not wait for a writer and does not spin without one", { skip: !canMkfifo || process.platform !== "linux" }, async function(t) {
	const h = setup(t);
	mkfifo(h.fifo);
	h.open(h.fifo);
	await new Promise(function(resolve) { setTimeout(resolve, 400); });
	assert.deepStrictEqual(h.seen.logs, ["reading " + h.fifo]);
	assert.strictEqual(h.seen.ends, 0, "idle is not a disconnect");
});

test("when the writer goes away onEnd is called, and a later writer is picked up", opts, async function(t) {
	const h = setup(t);
	mkfifo(h.fifo);
	h.open(h.fifo);
	await waitFor(function() { return h.seen.logs.length === 1; });
	const first = h.writer(h.fifo);
	first.write(item("core", "minm", "One"));
	await waitFor(function() { return h.seen.messages.length === 1; });
	await first.end();
	await waitFor(function() { return h.seen.ends === 1; });
	await waitFor(function() { return readings(h) === 2; }); // reading again
	assert.ok(h.seen.logs.some(function(l) { return l.includes("closed by the writer"); }), h.seen.logs.join("\n"));

	const second = h.writer(h.fifo);
	second.write(item("core", "minm", "Two"));
	await waitFor(function() { return h.seen.messages.length === 2; });
	assert.strictEqual(h.seen.messages[1][1].toString(), "Two");
});

test("a half-written item from a writer that died does not corrupt the next session", opts, async function(t) {
	const h = setup(t);
	mkfifo(h.fifo);
	h.open(h.fifo);
	await waitFor(function() { return h.seen.logs.length === 1; });
	const first = h.writer(h.fifo);
	first.write(item("core", "minm", "Lost").slice(0, 60));
	await first.end();
	await waitFor(function() { return h.seen.ends === 1 && readings(h) === 2; });
	const second = h.writer(h.fifo);
	second.write(item("core", "minm", "Next"));
	await waitFor(function() { return h.seen.messages.length === 1; });
	assert.strictEqual(h.seen.messages[0][1].toString(), "Next");
	assert.ok(!h.seen.logs.some(function(l) { return l.startsWith("bad item"); }), h.seen.logs.join("\n"));
});

test("a pipe that does not exist yet is retried, logging the problem once", opts, async function(t) {
	const h = setup(t);
	h.open(h.fifo);
	await new Promise(function(resolve) { setTimeout(resolve, 300); }); // several attempts at 20-40 ms
	assert.deepStrictEqual(h.seen.logs, ["cannot open " + h.fifo + ": ENOENT"]);

	mkfifo(h.fifo);
	await waitFor(function() { return h.seen.logs.length === 2; });
	assert.strictEqual(h.seen.logs[1], "reading " + h.fifo);
	const w = h.writer(h.fifo);
	w.write(item("core", "minm", "Song"));
	await waitFor(function() { return h.seen.messages.length === 1; });
});

test("a pipe that is deleted and recreated (shairport-sync restarted) is noticed", opts, async function(t) {
	const h = setup(t);
	mkfifo(h.fifo);
	h.open(h.fifo);
	await waitFor(function() { return h.seen.logs.length === 1; });

	fs.unlinkSync(h.fifo);
	mkfifo(h.fifo);
	await waitFor(function() { return h.seen.ends === 1; });
	assert.ok(h.seen.logs.some(function(l) { return l.includes("was replaced"); }));
	await waitFor(function() { return h.seen.logs[h.seen.logs.length - 1] === "reading " + h.fifo; });

	const w = h.writer(h.fifo);
	w.write(item("core", "minm", "After restart"));
	await waitFor(function() { return h.seen.messages.length === 1; });
	assert.strictEqual(h.seen.messages[0][1].toString(), "After restart");
});

test("something that is not a pipe is reported, not read", opts, async function(t) {
	const h = setup(t);
	fs.writeFileSync(h.fifo, "<item>");
	h.open(h.fifo);
	await waitFor(function() { return h.seen.logs.length > 0; });
	await new Promise(function(resolve) { setTimeout(resolve, 200); });
	assert.deepStrictEqual(h.seen.logs, [h.fifo + " is not a named pipe; set metadataPipe to the pipe_name of shairport-sync"]);
	assert.strictEqual(h.seen.messages.length, 0);
});

test("a malformed item is logged once and the items after it still arrive", opts, async function(t) {
	const h = setup(t);
	mkfifo(h.fifo);
	h.open(h.fifo);
	await waitFor(function() { return h.seen.logs.length === 1; });
	const w = h.writer(h.fifo);
	const bad = "<item><type>zzzz</type><code>6d696e6d</code><length>1</length></item>\n";
	w.write(bad + item("core", "minm", "One") + bad + item("core", "minm", "Two"));
	await waitFor(function() { return h.seen.messages.length === 2; });
	assert.strictEqual(h.seen.logs.filter(function(l) { return l.startsWith("bad item"); }).length, 1);
});

test("after close nothing more is delivered", opts, async function(t) {
	const h = setup(t);
	mkfifo(h.fifo);
	const reader = h.open(h.fifo);
	await waitFor(function() { return h.seen.logs.length === 1; });
	reader.close();
	const endsAtClose = h.seen.ends;
	const w = h.writer(h.fifo);
	w.write(item("core", "minm", "Song"));
	await new Promise(function(resolve) { setTimeout(resolve, 300); });
	assert.strictEqual(h.seen.messages.length, 0);
	assert.strictEqual(h.seen.ends, endsAtClose);
	w.end();
});
