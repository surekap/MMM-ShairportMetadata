/* Replays a capture of shairport-sync's MQTT messages and prints the state the
 * module would show after each one that matters. Capture on the Pi with:
 *
 *   mosquitto_sub -t 'shairport/#' -F '%U %t %x' > session.txt
 *
 * then run:  node test/replay.js session.txt
 */

const fs = require("fs");
const ShairportState = require("../ShairportState");

const lines = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean);
const t0 = parseFloat(lines[0]);
const state = new ShairportState();

for (const line of lines) {
	const [ts, topic, hex = ""] = line.split(" ");
	const ms = parseFloat(ts) * 1000;
	const code = topic.split("/").slice(1).join("/");
	if (!state.handle(code, Buffer.from(hex, "hex"), ms)) { continue; }

	const s = state.snapshot(ms, false);
	if ("artwork" in s) { s.artwork = s.artwork ? "<" + s.artwork.length + " chars>" : null; }
	if (typeof s.position === "number") { s.position = Math.round(s.position * 100) / 100; }
	console.log((parseFloat(ts) - t0).toFixed(3).padStart(8), code.padEnd(10), JSON.stringify(s));
}
