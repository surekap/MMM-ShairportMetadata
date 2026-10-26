const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { item, classicTrack, copl } = require("./helpers");

const REPLAY = path.join(__dirname, "replay.js");

function replay(t, args, content, encoding) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmm-replay-"));
	t.after(function() { fs.rmSync(dir, { recursive: true, force: true }); });
	const file = path.join(dir, "capture");
	fs.writeFileSync(file, content, encoding || "latin1");
	return spawnSync(process.execPath, [REPLAY].concat(args, [file]), { encoding: "utf8" });
}

test("replays a pipe capture: the state after each change and a tally of the items", function(t) {
	const r = replay(t, [], classicTrack({ title: "Halo", artist: "Beyoncé".normalize() }) + item("ssnc", "pend"));
	assert.strictEqual(r.status, 0, r.stderr);
	assert.match(r.stdout, /"state":"playing","title":"Halo"/);
	assert.match(r.stdout, /"artwork":"<\d+ chars>"/, "artwork is summarised, not dumped");
	assert.match(r.stdout, /"state":"stopped"/);
	assert.match(r.stdout, /ssnc\/prgr\s+1/);
	assert.match(r.stdout, /core\/minm\s+1/);
});

test("replays an MQTT capture at its recorded times", function(t) {
	const hex = function(s) { return Buffer.from(s).toString("hex"); };
	const lines = [
		"1700000000.000 shairport/ssnc/pbeg ",
		"1700000000.100 shairport/core/minm " + hex("Song"),
		"1700000000.200 shairport/ssnc/prgr " + hex("0/441000/4410000"),
		"1700000000.300 shairport/ssnc/pffr ",
		"1700000030.300 shairport/ssnc/paus "
	].join("\n");
	const r = replay(t, ["--mqtt"], lines, "utf8");
	assert.strictEqual(r.status, 0, r.stderr);
	const pauseLine = r.stdout.split("\n").find(function(l) { return l.includes("ssnc/paus"); });
	assert.match(pauseLine, /"state":"paused"/);
	assert.match(pauseLine, /"position":40/, "10 s into the track when the playing began, plus 30 s");
});

test("reports what it could not use, and exits non-zero", function(t) {
	const r = replay(t, [], classicTrack() + item("ssnc", "prgr", "garbage") + item("ssnc", "copl", "not a plist"));
	assert.strictEqual(r.status, 1);
	assert.match(r.stdout, /2 problem\(s\)/);
	assert.match(r.stdout, /ssnc\/prgr: unusable progress 'garbage'/);
	assert.match(r.stdout, /ssnc\/copl/);
});

test("needs a file", function() {
	const r = spawnSync(process.execPath, [REPLAY], { encoding: "utf8" });
	assert.strictEqual(r.status, 2);
	assert.match(r.stderr, /usage/);
});
