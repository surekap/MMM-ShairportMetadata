// Builders for the data shairport-sync emits, so tests (and test/replay.js
// captures) don't need a running shairport-sync.

const bplist = require("bplist-creator");

const NPI = "kMRMediaRemoteNowPlayingInfo";

/** One item as it appears in the metadata pipe. */
function item(type, code, payload) {
	const hex = function(s) { return Buffer.from(s, "latin1").toString("hex"); };
	const head = "<item><type>" + hex(type) + "</type><code>" + hex(code) + "</code>";
	if (payload === undefined || payload.length === 0) {
		return head + "<length>0</length></item>\n";
	}
	const data = Buffer.from(payload);
	return head + "<length>" + data.length + "</length>\n<data encoding=\"base64\">\n" + data.toString("base64") + "</data></item>\n";
}

/** The payload of ssnc/copl: AirPlay 2 now-playing info as a binary plist. */
function copl(info) {
	const params = {};
	Object.keys(info).forEach(function(k) { params[NPI + k] = info[k]; });
	return bplist({ type: "updateMRNowPlayingInfo", params: { params: params } });
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64)]);

/** A classic AirPlay track start, as pipe items. */
function classicTrack(opts = {}) {
	const o = Object.assign({ title: "Song", artist: "Artist", album: "Album", start: 1000, current: 1000, end: 1000 + 200 * 44100 }, opts);
	return [
		item("ssnc", "mdst"),
		item("core", "asar", o.artist),
		item("core", "asal", o.album),
		item("core", "minm", o.title),
		item("ssnc", "PICT", JPEG),
		item("ssnc", "mden"),
		item("ssnc", "prgr", o.start + "/" + o.current + "/" + o.end),
		item("ssnc", "pffr")
	].join("");
}

/** Resolves when `predicate()` is true, polling; rejects after `ms`. */
function waitFor(predicate, ms = 3000) {
	return new Promise(function(resolve, reject) {
		const t0 = Date.now();
		(function poll() {
			let ok;
			try { ok = predicate(); } catch (e) { return reject(e); }
			if (ok) { return resolve(); }
			if (Date.now() - t0 > ms) { return reject(new Error("timed out waiting for condition: " + predicate)); }
			setTimeout(poll, 10);
		})();
	});
}

module.exports = { item, copl, classicTrack, waitFor, JPEG, PNG, NPI };
