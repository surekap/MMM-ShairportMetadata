// Runs openMqtt against a real (in-process) MQTT broker.

const test = require("node:test");
const assert = require("node:assert");
const net = require("net");
const { Aedes } = require("aedes");
const { openMqtt } = require("../transports");
const { waitFor } = require("./helpers");

const FAST = { minDelay: 20, maxDelay: 40 };

async function freePort() {
	return new Promise(function(resolve) {
		const s = net.createServer().listen(0, "127.0.0.1", function() {
			const port = s.address().port;
			s.close(function() { resolve(port); });
		});
	});
}

/** A broker that can be stopped and started again on the same port, like a restarted mosquitto. */
async function brokerOn(t, port) {
	const b = { port: port, subscriptions: 0, aedes: null, server: null, sockets: new Set() };
	b.start = async function() {
		b.subscriptions = 0; // counted afresh by each run of the broker
		b.aedes = await Aedes.createBroker();
		b.aedes.on("subscribe", function() { b.subscriptions++; });
		b.server = net.createServer(b.aedes.handle);
		b.server.on("connection", function(sock) {
			b.sockets.add(sock);
			sock.on("close", function() { b.sockets.delete(sock); });
		});
		await new Promise(function(resolve) { b.server.listen(port, "127.0.0.1", resolve); });
	};
	b.stop = async function() {
		b.sockets.forEach(function(sock) { sock.destroy(); });
		await new Promise(function(resolve) { b.server.close(resolve); });
		await new Promise(function(resolve) { b.aedes.close(resolve); });
		b.aedes = null;
	};
	b.publish = function(topic, payload) {
		return new Promise(function(resolve) {
			b.aedes.publish({ cmd: "publish", qos: 0, retain: false, dup: false, topic: topic, payload: Buffer.from(payload) }, resolve);
		});
	};
	t.after(async function() { if (b.aedes) { await b.stop(); } });
	return b;
}

function listener(t) {
	const seen = { messages: [], ends: 0, logs: [] };
	const handlers = {
		onMessage: function(code, payload) {
			if (code === "core/explode") { throw new Error("consumer broke"); }
			seen.messages.push([code, payload.toString()]);
		},
		onEnd: function() { seen.ends++; },
		log: function(message) { seen.logs.push(message); }
	};
	const transports = [];
	t.after(function() { transports.forEach(function(x) { x.close(); }); });
	return {
		seen: seen,
		open: function(port, topic) {
			const x = openMqtt({ url: "mqtt://127.0.0.1:" + port, topic: topic || "shairport" }, handlers, FAST);
			transports.push(x);
			return x;
		}
	};
}

test("receives the raw ssnc and core topics under the configured topic", async function(t) {
	const broker = await brokerOn(t, await freePort());
	await broker.start();
	const l = listener(t);
	l.open(broker.port);
	await waitFor(function() { return broker.subscriptions > 0; });

	await broker.publish("shairport/ssnc/pbeg", "");
	await broker.publish("shairport/core/minm", "Song");
	await broker.publish("shairport/ssnc/copl", "\u0000\u0001binary");
	await waitFor(function() { return l.seen.messages.length === 3; });
	assert.deepStrictEqual(l.seen.messages.map(function(m) { return m[0]; }), ["ssnc/pbeg", "core/minm", "ssnc/copl"]);
	assert.strictEqual(l.seen.messages[1][1], "Song");
	assert.ok(l.seen.logs.some(function(x) { return x.startsWith("connected to "); }));
});

test("ignores other topics, and accepts a topic with a trailing slash", async function(t) {
	const broker = await brokerOn(t, await freePort());
	await broker.start();
	const l = listener(t);
	l.open(broker.port, "home/airplay/");
	await waitFor(function() { return broker.subscriptions > 0; });

	await broker.publish("shairport/core/minm", "wrong topic");
	await broker.publish("home/airplay/artist", "parsed topic, not subscribed");
	await broker.publish("home/airplay/core/minm", "Song");
	await waitFor(function() { return l.seen.messages.length === 1; });
	await new Promise(function(resolve) { setTimeout(resolve, 100); });
	assert.deepStrictEqual(l.seen.messages, [["core/minm", "Song"]]);
});

test("a broker that is not up yet is retried, logging the problem once", async function(t) {
	const port = await freePort();
	const broker = await brokerOn(t, port);
	const l = listener(t);
	l.open(port);
	await new Promise(function(resolve) { setTimeout(resolve, 400); }); // several attempts at 20-40 ms
	const errors = l.seen.logs.filter(function(x) { return x.startsWith("MQTT error"); });
	assert.strictEqual(errors.length, 1, l.seen.logs.join("\n"));
	assert.match(errors[0], /ECONNREFUSED/);

	await broker.start();
	await waitFor(function() { return broker.subscriptions > 0; });
	await broker.publish("shairport/core/minm", "Song");
	await waitFor(function() { return l.seen.messages.length === 1; });
});

test("when the broker goes away onEnd is called, and it reconnects when the broker is back", async function(t) {
	const broker = await brokerOn(t, await freePort());
	await broker.start();
	const l = listener(t);
	l.open(broker.port);
	await waitFor(function() { return broker.subscriptions === 1; });

	await broker.stop();
	await waitFor(function() { return l.seen.ends >= 1; });

	await broker.start();
	await waitFor(function() { return broker.subscriptions === 1; });
	await broker.publish("shairport/core/minm", "Back");
	await waitFor(function() { return l.seen.messages.length === 1; });
	assert.strictEqual(l.seen.messages[0][1], "Back");
});

test("a message the consumer cannot handle is logged and the next one still arrives", async function(t) {
	const broker = await brokerOn(t, await freePort());
	await broker.start();
	const l = listener(t);
	l.open(broker.port);
	await waitFor(function() { return broker.subscriptions > 0; });

	await broker.publish("shairport/core/explode", "x");
	await broker.publish("shairport/core/minm", "Song");
	await waitFor(function() { return l.seen.messages.length === 1; });
	assert.ok(l.seen.logs.some(function(x) { return x.includes("consumer broke"); }), l.seen.logs.join("\n"));
});

test("after close it neither delivers nor reconnects", async function(t) {
	const broker = await brokerOn(t, await freePort());
	await broker.start();
	const l = listener(t);
	const x = l.open(broker.port);
	await waitFor(function() { return broker.subscriptions === 1; });
	x.close();
	await broker.stop();
	await broker.start();
	await new Promise(function(resolve) { setTimeout(resolve, 300); });
	assert.strictEqual(broker.subscriptions, 0, "no new subscription after close");
});
