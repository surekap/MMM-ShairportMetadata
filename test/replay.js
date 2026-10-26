/* Replays a capture of shairport-sync's metadata through the same parser and
 * state as the module and prints what it would show after each item that
 * changes it, then a tally of the items seen. Use it to see what a sender
 * really sends, and to turn a capture from an issue into a test.
 *
 *   node test/replay.js capture.raw
 *       a capture of the pipe, taken with MagicMirror stopped:
 *       timeout 60 cat /tmp/shairport-sync-metadata > capture.raw
 *
 *   node test/replay.js --mqtt session.txt
 *       a capture of the MQTT topics:
 *       mosquitto_sub -t 'shairport/#' -F '%U %t %x' > session.txt
 *
 * A pipe capture has no timestamps, so the clock does not advance between its
 * items; an MQTT capture replays at its recorded times.
 */

const fs = require("fs");
const ShairportState = require("../ShairportState");
const { PipeParser } = require("../transports");

const args = process.argv.slice(2);
const mqtt = args.includes("--mqtt");
const file = args.find(function(a) { return !a.startsWith("--"); });
if (!file) {
	console.error("usage: node test/replay.js [--mqtt] <capture>");
	process.exit(2);
}

const state = new ShairportState();
const tally = {};
const errors = [];
let t0 = null;

function show(code, ms) {
	const s = state.snapshot(ms, false);
	if ("artwork" in s) { s.artwork = s.artwork ? "<" + s.artwork.length + " chars>" : null; }
	if (typeof s.position === "number") { s.position = Math.round(s.position * 100) / 100; }
	console.log(((ms - t0) / 1000).toFixed(3).padStart(8), code.padEnd(10), JSON.stringify(s));
}

function apply(code, payload, ms) {
	if (t0 === null) { t0 = ms; }
	tally[code] = (tally[code] || 0) + 1;
	let changed;
	try {
		changed = state.handle(code, payload, ms);
	} catch (err) {
		errors.push(code + ": " + err.message);
		return;
	}
	if (changed) { show(code, ms); }
}

if (mqtt) {
	fs.readFileSync(file, "utf8").split("\n").filter(Boolean).forEach(function(line) {
		const parts = line.split(" ");
		apply(parts[1].split("/").slice(1).join("/"), Buffer.from(parts[2] || "", "hex"), parseFloat(parts[0]) * 1000);
	});
} else {
	new PipeParser(
		function(type, code, data) { apply(type + "/" + code, data, 0); },
		function(err) { errors.push(err.message); }
	).write(fs.readFileSync(file, "latin1"));
}

console.log("\nitems seen:");
Object.keys(tally).sort().forEach(function(code) { console.log("  " + code.padEnd(10), tally[code]); });
if (errors.length) {
	console.log("\n" + errors.length + " problem(s):");
	errors.forEach(function(e) { console.log("  " + e); });
	process.exitCode = 1;
}
