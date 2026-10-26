// node_helper.js wired to a real pipe / broker: what the browser would be sent.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const Module = require("module");
const { execFileSync, spawn } = require("child_process");
const { Aedes } = require("aedes");
const { item, classicTrack, waitFor, JPEG } = require("./helpers");

// `require("node_helper")` resolves to the stub
const resolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...rest) {
	return request === "node_helper" ? path.join(__dirname, "stubs", "node_helper.js") : resolve.call(this, request, ...rest);
};
const definition = require("../node_helper");
Module._resolveFilename = resolve;

const CONFIG = { transport: "pipe", metadataPipe: "", mqttUrl: "", mqttTopic: "shairport", sampleRate: 44100 };

function newHelper(t) {
	const helper = Object.assign({}, definition, { sent: [] });
	helper.start();
	t.after(function() { helper.stop(); });
	return helper;
}

function states(helper) {
	return helper.sent.filter(function(m) { return m[0] === "STATE"; }).map(function(m) { return m[1]; });
}

function captureLog(t) {
	const lines = [];
	const original = console.log;
	console.log = function(...args) { lines.push(args.join(" ")); };
	t.after(function() { console.log = original; });
	return lines;
}

test("pipe: a track, a pause and the end of the session reach the browser as states", async function(t) {
	captureLog(t);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmm-helper-"));
	t.after(function() { fs.rmSync(dir, { recursive: true, force: true }); });
	const fifo = path.join(dir, "metadata");
	execFileSync("mkfifo", [fifo]);

	const helper = newHelper(t);
	helper.socketNotificationReceived("CONFIG", Object.assign({}, CONFIG, { metadataPipe: fifo }));
	assert.deepStrictEqual(states(helper), [{ state: "stopped" }], "a browser that connects gets the current state at once");
	await new Promise(function(resolve) { setTimeout(resolve, 100); }); // the pipe is opened

	const writer = spawn("sh", ["-c", "exec cat > \"$1\"", "sh", fifo], { stdio: ["pipe", "ignore", "inherit"] });
	t.after(function() { writer.kill(); });

	writer.stdin.write(classicTrack({ title: "Halo", artist: "Beyoncé", album: "I Am..." }));
	await waitFor(function() { return states(helper).length === 2; });
	const playing = states(helper)[1];
	assert.strictEqual(playing.state, "playing");
	assert.strictEqual(playing.title, "Halo");
	assert.strictEqual(playing.artist, "Beyoncé");
	assert.strictEqual(playing.duration, 200);
	assert.match(playing.artwork, /^data:image\/jpeg;base64,/);

	writer.stdin.write(item("ssnc", "pfls"));
	await waitFor(function() { return states(helper).length === 3; });
	assert.strictEqual(states(helper)[2].state, "paused");
	assert.ok(!("artwork" in states(helper)[2]), "the artwork is not sent again");

	writer.stdin.end();
	await waitFor(function() { return states(helper).length === 4; });
	assert.deepStrictEqual(states(helper)[3], { state: "stopped" }, "the sender going away hides the card");
});

test("the items of one metadata bundle are sent as one state", async function(t) {
	captureLog(t);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmm-helper-"));
	t.after(function() { fs.rmSync(dir, { recursive: true, force: true }); });
	const fifo = path.join(dir, "metadata");
	execFileSync("mkfifo", [fifo]);
	const helper = newHelper(t);
	helper.socketNotificationReceived("CONFIG", Object.assign({}, CONFIG, { metadataPipe: fifo }));
	await new Promise(function(resolve) { setTimeout(resolve, 100); });

	const writer = spawn("sh", ["-c", "exec cat > \"$1\"", "sh", fifo], { stdio: ["pipe", "ignore", "inherit"] });
	t.after(function() { writer.kill(); });
	writer.stdin.write(item("ssnc", "pbeg") + classicTrack());
	await waitFor(function() { return states(helper).length >= 2; });
	await new Promise(function(resolve) { setTimeout(resolve, 150); });
	assert.strictEqual(states(helper).length, 2, "one for the connect, one for the whole bundle");
});

test("a reloaded browser gets the full state again, artwork included", async function(t) {
	captureLog(t);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmm-helper-"));
	t.after(function() { fs.rmSync(dir, { recursive: true, force: true }); });
	const fifo = path.join(dir, "metadata");
	execFileSync("mkfifo", [fifo]);
	const helper = newHelper(t);
	const config = Object.assign({}, CONFIG, { metadataPipe: fifo });
	helper.socketNotificationReceived("CONFIG", config);
	await new Promise(function(resolve) { setTimeout(resolve, 100); });
	const writer = spawn("sh", ["-c", "exec cat > \"$1\"", "sh", fifo], { stdio: ["pipe", "ignore", "inherit"] });
	t.after(function() { writer.kill(); });
	writer.stdin.write(classicTrack());
	await waitFor(function() { return states(helper).length === 2; });

	helper.socketNotificationReceived("CONFIG", config);
	const again = states(helper)[2];
	assert.strictEqual(again.state, "playing");
	assert.strictEqual(again.title, "Song");
	assert.match(again.artwork, /^data:image\/jpeg;base64,/);
	assert.strictEqual(helper.transport !== null, true);
});

test("mqtt: states come from the broker's raw topics", async function(t) {
	captureLog(t);
	const aedes = await Aedes.createBroker();
	const server = net.createServer(aedes.handle);
	const sockets = new Set();
	server.on("connection", function(sock) {
		sockets.add(sock);
		sock.on("close", function() { sockets.delete(sock); });
	});
	let subscribed = 0;
	aedes.on("subscribe", function() { subscribed++; });
	await new Promise(function(resolve) { server.listen(0, "127.0.0.1", resolve); });
	t.after(async function() {
		sockets.forEach(function(sock) { sock.destroy(); });
		await new Promise(function(resolve) { server.close(resolve); });
		await new Promise(function(resolve) { aedes.close(resolve); });
	});
	const publish = function(topic, payload) {
		return new Promise(function(resolve) {
			aedes.publish({ cmd: "publish", qos: 0, retain: false, dup: false, topic: topic, payload: Buffer.from(payload) }, resolve);
		});
	};

	const helper = newHelper(t);
	helper.socketNotificationReceived("CONFIG", Object.assign({}, CONFIG, {
		transport: "mqtt", mqttUrl: "mqtt://127.0.0.1:" + server.address().port
	}));
	await waitFor(function() { return subscribed > 0; });
	await publish("shairport/ssnc/pbeg", "");
	await publish("shairport/core/minm", "Over MQTT");
	await publish("shairport/ssnc/prgr", "0/441000/4410000");
	await publish("shairport/ssnc/pffr", "");
	await waitFor(function() { return states(helper).some(function(s) { return s.title === "Over MQTT"; }); });
	const s = states(helper).filter(function(x) { return x.title === "Over MQTT"; }).pop();
	assert.strictEqual(s.state, "playing");
	assert.strictEqual(s.duration, 100);
});

test("an unknown transport is reported, and does not throw", function(t) {
	const lines = captureLog(t);
	const helper = newHelper(t);
	assert.doesNotThrow(function() {
		helper.socketNotificationReceived("CONFIG", Object.assign({}, CONFIG, { transport: "carrier-pigeon" }));
	});
	assert.ok(lines.some(function(l) { return l.includes("unknown transport 'carrier-pigeon'"); }), lines.join("\n"));
	assert.deepStrictEqual(states(helper), [{ state: "stopped" }]);
});

test("notifications other than CONFIG are ignored", function(t) {
	const helper = newHelper(t);
	helper.socketNotificationReceived("SOMETHING_ELSE", {});
	assert.deepStrictEqual(helper.sent, []);
});
