/* Magic Mirror
 * Module: MMM-ShairportMetadata
 *
 * The two ways to get shairport-sync's metadata: the named pipe (default) and
 * MQTT. Both hand every item to `onMessage(code, payload, ms)` as
 * "<type>/<code>" (e.g. "ssnc/pbeg") plus a Buffer, call `onEnd()` when the
 * sender goes away, and reconnect with exponential backoff until `close()`.
 *
 * MIT Licensed.
 */

const fs = require("fs");
const net = require("net");

const MIN_DELAY = 1000;
const MAX_DELAY = 30000;
const WATCH_MS = 10000;
const MAX_BUFFER = 32 * 1024 * 1024;

const ITEM = /^<item><type>([0-9a-f]{8})<\/type><code>([0-9a-f]{8})<\/code><length>(\d+)<\/length>\s*(?:<data encoding="base64">([\s\S]*?)<\/data>)?\s*<\/item>$/i;
const ITEM_END = "</item>";

/**
 * Cuts the metadata pipe's byte stream into items. An item looks like
 *
 *   <item><type>73736e63</type><code>70626567</code><length>0</length></item>
 *
 * or, with data (type and code are 4 characters in hex, data is base64):
 *
 *   <item><type>636f7265</type><code>6d696e6d</code><length>4</length>
 *   <data encoding="base64">
 *   c29uZw==</data></item>
 *
 * A malformed item is reported to `onError` and skipped; the rest of the
 * stream is still read.
 */
class PipeParser {

	constructor(onItem, onError) {
		this.onItem = onItem;
		this.onError = onError;
		this.reset();
	}

	/** Forget a half-read item, e.g. after reconnecting. */
	reset() {
		this.buf = "";
		this.scan = 0;
	}

	/** @param {string} chunk latin1 text; the framing and the base64 are ASCII */
	write(chunk) {
		this.buf += chunk;
		for (;;) {
			const end = this.buf.indexOf(ITEM_END, this.scan);
			if (end < 0) { break; }
			const raw = this.buf.slice(0, end + ITEM_END.length);
			this.buf = this.buf.slice(end + ITEM_END.length);
			this.scan = 0;
			this.parse(raw);
		}
		this.scan = Math.max(0, this.buf.length - ITEM_END.length + 1);
		if (this.buf.length > MAX_BUFFER) {
			this.reset();
			this.onError(new Error("no end of item within " + MAX_BUFFER + " bytes; dropped"));
		}
	}

	parse(raw) {
		// Joining the stream half way through an item leaves its tail without a start; that is not an error.
		const start = raw.lastIndexOf("<item>");
		if (start < 0) { return; }
		let type, code, data;
		try {
			const m = ITEM.exec(raw.slice(start));
			if (!m) { throw new Error("malformed item: " + raw.slice(start, start + 60)); }
			type = Buffer.from(m[1], "hex").toString("latin1");
			code = Buffer.from(m[2], "hex").toString("latin1");
			data = Buffer.from(m[4] || "", "base64");
			if (data.length !== Number(m[3])) {
				throw new Error(type + "/" + code + ": length " + m[3] + " announced, " + data.length + " bytes of data");
			}
		} catch (err) {
			this.onError(err);
			return;
		}
		try {
			this.onItem(type, code, data);
		} catch (err) {
			this.onError(err);
		}
	}
}

function describe(err) {
	return err.code || err.message || (err.errors && err.errors[0] && (err.errors[0].code || err.errors[0].message)) || String(err);
}

/** Retry with doubling delays; remembers the last problem so a repeating one is logged once. */
function retrier(connect, log, opts) {
	const minDelay = opts.minDelay || MIN_DELAY;
	const maxDelay = opts.maxDelay || MAX_DELAY;
	let delay = minDelay;
	let timer = null;
	let lastProblem = "";
	return {
		note: function(problem) {
			if (problem !== lastProblem) {
				lastProblem = problem;
				log(problem);
			}
		},
		// the connection worked: let the next problem be logged again
		forget: function() { lastProblem = ""; },
		resetDelay: function() { delay = minDelay; },
		schedule: function() {
			if (timer) { return; }
			timer = setTimeout(function() { timer = null; connect(); }, delay);
			delay = Math.min(delay * 2, maxDelay);
		},
		cancel: function() { clearTimeout(timer); timer = null; }
	};
}

/**
 * Reads shairport-sync's metadata pipe. The pipe is opened without waiting for
 * shairport-sync (no thread is parked in open()), so a missing pipe or a
 * restarted shairport-sync only costs a retry. If the pipe file is deleted and
 * recreated the old one never gets a writer again; a watchdog notices.
 *
 * @param {string} path
 * @param {{onMessage: Function, onEnd: Function, log: Function}} handlers
 * @param {{minDelay?: number, maxDelay?: number, watchMs?: number}} [opts] for tests
 * @returns {{close: Function}}
 */
function openPipe(path, handlers, opts = {}) {
	const { onMessage, onEnd, log } = handlers;
	let socket = null;
	let inode = null;
	let closed = false;
	let watch = null;
	const retry = retrier(connect, log, opts);
	const parser = new PipeParser(
		function(type, code, data) { onMessage(type + "/" + code, data, Date.now()); },
		function(err) { retry.note("bad item in " + path + ": " + err.message); }
	);

	function drop() {
		const s = socket;
		socket = null;
		inode = null;
		if (s) { s.destroy(); }
	}

	function lost(problem) {
		if (problem) { retry.note(problem); }
		drop();
		onEnd();
		retry.schedule();
	}

	function connect() {
		fs.open(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK, function(err, fd) {
			if (closed) {
				if (!err) { fs.close(fd, function() {}); }
				return;
			}
			if (err) {
				retry.note("cannot open " + path + ": " + describe(err));
				retry.schedule();
				return;
			}
			let st;
			try {
				st = fs.fstatSync(fd);
			} catch (e) {
				fs.close(fd, function() {});
				retry.note("cannot stat " + path + ": " + describe(e));
				retry.schedule();
				return;
			}
			if (!st.isFIFO()) {
				fs.close(fd, function() {});
				retry.note(path + " is not a named pipe; set metadataPipe to the pipe_name of shairport-sync");
				retry.schedule();
				return;
			}
			log("reading " + path);
			retry.forget();
			inode = st.ino;
			parser.reset();
			const s = new net.Socket({ fd: fd, readable: true, writable: false });
			socket = s;
			s.setEncoding("latin1");
			s.on("data", function(chunk) {
				retry.resetDelay();
				parser.write(chunk);
			});
			s.on("error", function(e) {
				if (s === socket) { retry.note("error reading " + path + ": " + describe(e)); }
			});
			// the writer closed the pipe (shairport-sync stopped or restarted)
			s.on("close", function() {
				if (s === socket) { lost(path + " was closed by the writer; waiting for it again"); }
			});
		});
	}

	watch = setInterval(function() {
		if (!socket) { return; }
		fs.stat(path, function(err, st) {
			if (!socket || closed) { return; }
			if (err || st.ino !== inode) { lost(path + " was replaced; reopening"); }
		});
	}, opts.watchMs || WATCH_MS);
	watch.unref();

	connect();

	return {
		close: function() {
			closed = true;
			clearInterval(watch);
			retry.cancel();
			drop();
		}
	};
}

/**
 * Reads shairport-sync's raw MQTT topics (`publish_raw = "yes"`), published as
 * <topic>/<type>/<code> with the data as payload. Needs the `mqtt` package.
 *
 * @param {{url: string, topic: string}} broker
 * @param {{onMessage: Function, onEnd: Function, log: Function}} handlers
 * @param {{minDelay?: number, maxDelay?: number}} [opts] for tests
 * @returns {{close: Function}}
 */
function openMqtt(broker, handlers, opts = {}) {
	let mqtt;
	try {
		mqtt = require("mqtt");
	} catch (err) {
		throw new Error("transport \"mqtt\" needs the mqtt package: run `npm install` in the module folder");
	}
	const { onMessage, onEnd, log } = handlers;
	const prefix = broker.topic.replace(/\/+$/, "");
	let client = null;
	let closed = false;
	const retry = retrier(connect, log, opts);

	function drop() {
		const c = client;
		client = null;
		if (c) { c.end(true); }
	}

	function lost() {
		drop();
		onEnd();
		retry.schedule();
	}

	function connect() {
		if (closed) { return; }
		// reconnectPeriod 0: reconnecting is ours, so that it backs off
		const c = mqtt.connect(broker.url, { reconnectPeriod: 0, connectTimeout: 10000 });
		client = c;
		c.on("connect", function() {
			retry.resetDelay();
			retry.forget();
			log("connected to " + broker.url);
			c.subscribe([prefix + "/ssnc/#", prefix + "/core/#"], function(err) {
				if (err) { retry.note("cannot subscribe to " + prefix + ": " + describe(err)); }
			});
		});
		c.on("message", function(topic, payload) {
			if (!topic.startsWith(prefix + "/")) { return; }
			try {
				onMessage(topic.slice(prefix.length + 1), payload, Date.now());
			} catch (err) {
				retry.note("bad message on " + topic + ": " + err.message);
			}
		});
		c.on("error", function(err) {
			if (c === client) { retry.note("MQTT error: " + describe(err)); }
		});
		c.on("close", function() {
			if (c === client) { lost(); }
		});
	}

	connect();

	return {
		close: function() {
			closed = true;
			retry.cancel();
			drop();
		}
	};
}

module.exports = { PipeParser, openPipe, openMqtt };
