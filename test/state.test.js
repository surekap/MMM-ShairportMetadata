const test = require("node:test");
const assert = require("node:assert");
const ShairportState = require("../ShairportState");
const { copl, JPEG, PNG } = require("./helpers");

const T0 = 1700000000000;

function feed(state, ms, items) {
	items.forEach(function(it) { state.handle(it[0], Buffer.from(it[1] === undefined ? "" : it[1]), ms); });
}

function startClassic(state, extra = []) {
	feed(state, T0, [
		["ssnc/pbeg"],
		["ssnc/mdst"],
		["core/asar", "Artist"],
		["core/asal", "Album"],
		["core/minm", "Song"],
		["ssnc/mden"],
		["ssnc/prgr", "1000/" + (1000 + 10 * 44100) + "/" + (1000 + 200 * 44100)],
		["ssnc/pffr"]
	].concat(extra));
}

test("nothing is shown before anything is played", function() {
	assert.deepStrictEqual(new ShairportState().snapshot(T0, false), { state: "stopped" });
});

test("classic AirPlay: title, artist, album and the position from ssnc/prgr", function() {
	const s = new ShairportState();
	startClassic(s);
	const snap = s.snapshot(T0, false);
	assert.strictEqual(snap.state, "playing");
	assert.strictEqual(snap.title, "Song");
	assert.strictEqual(snap.artist, "Artist");
	assert.strictEqual(snap.album, "Album");
	assert.strictEqual(snap.duration, 200);
	assert.strictEqual(snap.position, 10);
	assert.strictEqual(snap.rate, 1);
});

test("the position advances with the wall clock, not with the number of snapshots", function() {
	const s = new ShairportState();
	startClassic(s);
	assert.strictEqual(s.snapshot(T0 + 30000, false).position, 40);
	assert.strictEqual(s.snapshot(T0 + 30000, false).position, 40);
	assert.strictEqual(s.snapshot(T0 + 90000, false).position, 100);
});

test("the position never passes the end of the track", function() {
	const s = new ShairportState();
	startClassic(s);
	assert.strictEqual(s.snapshot(T0 + 100 * 60000, false).position, 200);
});

test("pause freezes the position and resume continues from it", function() {
	const s = new ShairportState();
	startClassic(s);
	feed(s, T0 + 20000, [["ssnc/pfls"]]);
	assert.strictEqual(s.snapshot(T0 + 20000, false).state, "paused");
	assert.strictEqual(s.snapshot(T0 + 20000, false).position, 30);
	assert.strictEqual(s.snapshot(T0 + 500000, false).position, 30);
	feed(s, T0 + 600000, [["ssnc/prsm"]]);
	assert.strictEqual(s.snapshot(T0 + 600000, false).state, "playing");
	assert.strictEqual(s.snapshot(T0 + 605000, false).position, 35);
});

test("a seek (new ssnc/prgr) moves the position", function() {
	const s = new ShairportState();
	startClassic(s);
	feed(s, T0 + 5000, [["ssnc/prgr", "1000/" + (1000 + 120 * 44100) + "/" + (1000 + 200 * 44100)]]);
	assert.strictEqual(s.snapshot(T0 + 5000, false).position, 120);
});

test("ssnc/prgr honours the sample rate option", function() {
	const s = new ShairportState({ sampleRate: 48000 });
	feed(s, T0, [["ssnc/pbeg"], ["core/minm", "Song"], ["ssnc/prgr", "0/48000/480000"], ["ssnc/pffr"]]);
	assert.strictEqual(s.snapshot(T0, false).duration, 10);
	assert.strictEqual(s.snapshot(T0, false).position, 1);
});

test("an unusable ssnc/prgr is reported, not turned into a position", function() {
	const s = new ShairportState();
	startClassic(s);
	assert.throws(function() { s.handle("ssnc/prgr", Buffer.from("undefined"), T0); }, /unusable progress/);
	assert.throws(function() { s.handle("ssnc/prgr", Buffer.from("100/50/200"), T0); }, /unusable progress/);
	assert.throws(function() { s.handle("ssnc/prgr", Buffer.from("100/150/100"), T0); }, /unusable progress/);
	assert.strictEqual(s.snapshot(T0, false).position, 10);
});

test("text of the previous track does not linger when the next bundle lacks it", function() {
	const s = new ShairportState();
	startClassic(s);
	feed(s, T0 + 1000, [["ssnc/mdst"], ["core/minm", "Next song"], ["ssnc/mden"]]);
	const snap = s.snapshot(T0 + 1000, false);
	assert.strictEqual(snap.title, "Next song");
	assert.strictEqual(snap.artist, "");
	assert.strictEqual(snap.album, "");
});

test("the end of the session clears everything", function() {
	const s = new ShairportState();
	startClassic(s);
	assert.strictEqual(s.handle("ssnc/pend", Buffer.alloc(0), T0 + 1000), true);
	assert.deepStrictEqual(s.snapshot(T0 + 1000, false), { state: "stopped" });
	assert.strictEqual(s.end(), false, "nothing left to end");
});

test("artwork is sent when it changes, or when asked for", function() {
	const s = new ShairportState();
	startClassic(s, [["ssnc/PICT", JPEG]]);
	assert.match(s.snapshot(T0, false).artwork, /^data:image\/jpeg;base64,/);
	assert.ok(!("artwork" in s.snapshot(T0, false)), "unchanged artwork is not sent again");
	assert.match(s.snapshot(T0, true).artwork, /^data:image\/jpeg;base64,/);
	feed(s, T0, [["ssnc/PICT", PNG]]);
	assert.match(s.snapshot(T0, false).artwork, /^data:image\/png;base64,/);
	feed(s, T0, [["ssnc/PICT", ""]]);
	assert.strictEqual(s.snapshot(T0, false).artwork, null);
});

test("text that is not valid UTF-8 shows replacement characters instead of throwing", function() {
	const s = new ShairportState();
	assert.doesNotThrow(function() {
		s.handle("ssnc/pbeg", Buffer.alloc(0), T0);
		s.handle("core/minm", Buffer.from([0x43, 0x61, 0x66, 0xe9]), T0);
	});
	assert.strictEqual(s.snapshot(T0, false).title, "Caf�");
});

// ---- AirPlay 2 ----

const NOW = new Date(T0);

function airplay2(state, ms, info) {
	state.handle("ssnc/copl", copl(info), ms);
}

test("AirPlay 2: now-playing info gives title, duration, artwork and the position", function() {
	const s = new ShairportState();
	feed(s, T0, [["ssnc/abeg"]]);
	airplay2(s, T0, {
		ContentItemIdentifier: "item-1", Title: "Halo", Artist: "Beyoncé", Album: "I Am...", Duration: 261.5,
		ArtworkData: PNG, Timestamp: NOW, PlaybackRate: 1, ElapsedTime: 42
	});
	const snap = s.snapshot(T0 + 8000, false);
	assert.strictEqual(snap.state, "playing");
	assert.strictEqual(snap.title, "Halo");
	assert.strictEqual(snap.artist, "Beyoncé");
	assert.strictEqual(snap.album, "I Am...");
	assert.strictEqual(snap.duration, 261.5);
	assert.strictEqual(snap.position, 50);
	assert.match(snap.artwork, /^data:image\/png;base64,/);
});

test("AirPlay 2: pause, seek and resume", function() {
	const s = new ShairportState();
	airplay2(s, T0, { ContentItemIdentifier: "a", Title: "T", Duration: 300, Timestamp: NOW, PlaybackRate: 1, ElapsedTime: 0 });
	feed(s, T0 + 10000, [["ssnc/paus"]]);
	assert.strictEqual(s.snapshot(T0 + 99000, false).state, "paused");
	assert.strictEqual(s.snapshot(T0 + 99000, false).position, 10);
	// seeking while paused: elapsed jumps, rate stays 0
	airplay2(s, T0 + 100000, { Timestamp: new Date(T0 + 100000), PlaybackRate: 0, ElapsedTime: 200 });
	assert.strictEqual(s.snapshot(T0 + 150000, false).position, 200);
	airplay2(s, T0 + 160000, { Timestamp: new Date(T0 + 160000), PlaybackRate: 1, ElapsedTime: 200 });
	assert.strictEqual(s.snapshot(T0 + 165000, false).position, 205);
});

test("AirPlay 2: a new item resets the track; an update without artwork keeps the artwork", function() {
	const s = new ShairportState();
	airplay2(s, T0, { ContentItemIdentifier: "a", Title: "One", Artist: "X", Duration: 100, ArtworkData: JPEG, Timestamp: NOW, PlaybackRate: 1, ElapsedTime: 50 });
	s.snapshot(T0, false);
	airplay2(s, T0 + 1000, { ContentItemIdentifier: "a", Title: "One (remastered)" });
	const same = s.snapshot(T0 + 1000, false);
	assert.strictEqual(same.title, "One (remastered)");
	assert.ok(!("artwork" in same));
	assert.strictEqual(same.position, 51, "same item keeps its position");
	airplay2(s, T0 + 2000, { ContentItemIdentifier: "b", Title: "Two" });
	const next = s.snapshot(T0 + 2000, false);
	assert.strictEqual(next.title, "Two");
	assert.strictEqual(next.artist, "");
	assert.strictEqual(next.artwork, null);
	assert.strictEqual(next.position, 0);
});

test("AirPlay 2: once seen, classic tags and ssnc/prgr no longer change anything", function() {
	const s = new ShairportState();
	airplay2(s, T0, { ContentItemIdentifier: "a", Title: "From plist", Duration: 100, Timestamp: NOW, PlaybackRate: 1, ElapsedTime: 10 });
	feed(s, T0, [["core/minm", "From tag"], ["ssnc/prgr", "0/441000/4410000"], ["ssnc/PICT", JPEG]]);
	const snap = s.snapshot(T0, false);
	assert.strictEqual(snap.title, "From plist");
	assert.strictEqual(snap.duration, 100);
	assert.strictEqual(snap.position, 10);
});

test("AirPlay 2: a sender clock that disagrees with ours is not trusted", function() {
	const s = new ShairportState();
	// sender's timestamp is 10 minutes behind ours: using it would put the position 10 minutes ahead
	airplay2(s, T0, { ContentItemIdentifier: "a", Title: "T", Duration: 3600, Timestamp: new Date(T0 - 600000), PlaybackRate: 1, ElapsedTime: 30 });
	assert.strictEqual(s.snapshot(T0, false).position, 30);
	// a small difference is used as given
	airplay2(s, T0, { Timestamp: new Date(T0 - 2000), PlaybackRate: 1, ElapsedTime: 30 });
	assert.strictEqual(s.snapshot(T0, false).position, 32);
});

test("AirPlay 2: live streams have no duration", function() {
	const s = new ShairportState();
	airplay2(s, T0, { ContentItemIdentifier: "a", Title: "Radio", Duration: 0, IsAlwaysLive: true, Timestamp: NOW, PlaybackRate: 1, ElapsedTime: 5 });
	assert.strictEqual(s.snapshot(T0, false).duration, 0);
});

test("AirPlay 2: an unusable plist is reported", function() {
	const s = new ShairportState();
	assert.throws(function() { s.handle("ssnc/copl", Buffer.from("not a plist"), T0); }, /ssnc\/copl/);
	assert.strictEqual(s.handle("ssnc/copl", copl({}), T0), false);
});

test("a disconnect from the connected sender ends the session at once; another sender's does not", function() {
	const s = new ShairportState();
	feed(s, T0, [["ssnc/clip", "192.168.1.20"]]);
	airplay2(s, T0, { ContentItemIdentifier: "a", Title: "T", Timestamp: NOW, PlaybackRate: 1, ElapsedTime: 0 });
	assert.strictEqual(s.handle("ssnc/disc", Buffer.from("192.168.1.99"), T0), false);
	assert.strictEqual(s.snapshot(T0, false).state, "playing");
	assert.strictEqual(s.handle("ssnc/disc", Buffer.from("192.168.1.20"), T0), true);
	assert.strictEqual(s.snapshot(T0, false).state, "stopped");
});
