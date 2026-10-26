/* Magic Mirror
 * Module: MMM-ShairportMetadata
 *
 * Turns the items shairport-sync publishes (metadata pipe or MQTT) into one
 * "now playing" state. It does no I/O and knows nothing of MagicMirror, so it
 * can be replayed against a capture (see test/replay.js).
 *
 * The playback position is an anchor: `elapsed` seconds at time `at` (ms),
 * advancing at `rate` (1 playing, 0 paused). Everything shown is derived from
 * it, so nobody has to count ticks.
 *
 * The anchor design and the parsing of AirPlay 2 "now playing" info (ssnc/copl)
 * come from pull request #21 by Dnovak043.
 *
 * AirPlay 2 senders such as Apple Music send MediaRemote now-playing info as a
 * binary plist on ssnc/copl. It is the only source of playback position there,
 * so once it has been seen in a session it is used for everything; the classic
 * core/* tags, ssnc/prgr and ssnc/PICT are only used for senders without it.
 *
 * MIT Licensed.
 */

const NPI = "kMRMediaRemoteNowPlayingInfo";

// The sender's timestamp is only trusted while its clock agrees with ours;
// otherwise the position would be off by the difference.
const MAX_CLOCK_SKEW_MS = 5000;

let bplist; // loaded on first use: only AirPlay 2 senders need it

function parsePlist(payload) {
	if (!bplist) {
		try {
			bplist = require("bplist-parser");
		} catch (err) {
			throw new Error("AirPlay 2 now-playing info needs bplist-parser: run `npm install` in the module folder");
		}
	}
	return bplist.parseBuffer(payload);
}

function emptyTrack() {
	return { id: null, title: "", artist: "", album: "", duration: 0, live: false, artwork: null };
}

function text(payload) {
	return payload.toString("utf8");
}

function imageMime(buf) {
	return (buf[0] === 0x89 && buf[1] === 0x50) ? "image/png" : "image/jpeg";
}

class ShairportState {

	/**
	 * @param {object} [options]
	 * @param {number} [options.sampleRate=44100] RTP clock of ssnc/prgr
	 */
	constructor(options = {}) {
		this.sampleRate = options.sampleRate > 0 ? options.sampleRate : 44100;
		this.reset();
	}

	reset() {
		this.active = false;      // a play session is in progress
		this.clientIp = null;     // address of the connected sender, for matching ssnc/disc
		this.coplSeen = false;    // sender provides MediaRemote now-playing info
		this.fresh = false;       // a classic metadata bundle began; its first tag clears the old text
		this.track = emptyTrack();
		this.anchor = { elapsed: 0, at: 0, rate: 0 };
		this.artworkDirty = true;
	}

	positionAt(ms) {
		const a = this.anchor;
		const p = a.elapsed + (ms - a.at) / 1000 * a.rate;
		return Math.min(Math.max(p, 0), this.track.duration || Infinity);
	}

	setRate(rate, ms) {
		this.anchor = { elapsed: this.positionAt(ms), at: ms, rate: rate };
	}

	setArtwork(buf) {
		const art = buf.length ? "data:" + imageMime(buf) + ";base64," + buf.toString("base64") : null;
		if (art !== this.track.artwork) {
			this.track.artwork = art;
			this.artworkDirty = true;
		}
	}

	/** The sender is gone. Returns true if something was showing. */
	end() {
		const wasActive = this.active;
		this.reset();
		return wasActive;
	}

	/**
	 * Applies one item. `code` is "<type>/<code>", e.g. "ssnc/copl", the same
	 * as the MQTT topic without its prefix. Returns true if what is shown may
	 * have changed.
	 */
	handle(code, payload, ms) {
		switch (code) {
			case "ssnc/conn":
			case "ssnc/clip":
				this.clientIp = text(payload);
				return false;

			// The sender disconnected. pend follows ~20 s later, which is too slow.
			case "ssnc/disc":
				if (this.clientIp && text(payload) !== this.clientIp) { return false; }
				return this.end();

			case "ssnc/pend":
			case "ssnc/aend":
				return this.end();

			case "ssnc/abeg":
			case "ssnc/pbeg":
			case "ssnc/pres":
				this.active = true;
				return true;

			// Resume / first frame. Now-playing info usually follows with the exact
			// position; until then assume playback continues from where it paused.
			case "ssnc/prsm":
			case "ssnc/pffr":
				this.active = true;
				if (this.anchor.rate === 0) { this.setRate(1, ms); }
				return true;

			// Pause arrives only as an event; no now-playing update accompanies it.
			case "ssnc/paus":
			case "ssnc/pfls":
				this.setRate(0, ms);
				return true;

			case "ssnc/mdst":
				this.fresh = true;
				return false;

			case "ssnc/prgr":
				return this.handleProgress(payload, ms);

			case "ssnc/copl":
				return this.handleNowPlaying(payload, ms);
		}

		if (this.coplSeen) { return false; }
		return this.handleClassic(code, payload, ms);
	}

	handleNowPlaying(payload, ms) {
		let msg;
		try {
			msg = parsePlist(payload)[0];
		} catch (err) {
			throw new Error("ssnc/copl: " + err.message);
		}
		if (!msg || msg.type !== "updateMRNowPlayingInfo" || !msg.params) { return false; }
		const info = msg.params.params || {};
		if (Object.keys(info).length === 0) { return false; }
		const get = function(key) { return info[NPI + key]; };
		this.coplSeen = true;

		// A new item resets everything. "replace" messages for the same item can
		// omit the artwork, so fields are only ever overwritten, never cleared.
		const id = get("ContentItemIdentifier");
		if (id && id !== this.track.id) {
			this.track = emptyTrack();
			this.track.id = id;
			this.artworkDirty = true;
			this.anchor = { elapsed: 0, at: ms, rate: this.anchor.rate };
		}
		if (typeof get("Title") === "string") { this.track.title = get("Title"); }
		if (typeof get("Artist") === "string") { this.track.artist = get("Artist"); }
		if (typeof get("Album") === "string") { this.track.album = get("Album"); }
		if (typeof get("Duration") === "number") { this.track.duration = get("Duration"); }
		if (get("IsAlwaysLive") !== undefined) { this.track.live = !!get("IsAlwaysLive"); }
		if (Buffer.isBuffer(get("ArtworkData"))) { this.setArtwork(get("ArtworkData")); }

		// ElapsedTime is the position at Timestamp.
		const hasTiming = ["Timestamp", "PlaybackRate", "ElapsedTime"].some(function(k) {
			return get(k) !== undefined;
		});
		if (hasTiming) {
			const stamp = get("Timestamp");
			const trusted = stamp instanceof Date && Math.abs(stamp.getTime() - ms) <= MAX_CLOCK_SKEW_MS;
			const at = trusted ? stamp.getTime() : ms;
			const rate = typeof get("PlaybackRate") === "number" ? get("PlaybackRate") : this.anchor.rate;
			const elapsed = typeof get("ElapsedTime") === "number" ? get("ElapsedTime") : this.positionAt(at);
			this.anchor = { elapsed: elapsed, at: at, rate: rate };
			if (rate > 0) { this.active = true; }
		}
		return true;
	}

	/** Classic AirPlay: "start/current/end" in RTP frames, sent when playback starts or jumps. */
	handleProgress(payload, ms) {
		if (this.coplSeen) { return false; }
		const [start, current, end] = text(payload).split("/").map(Number);
		if (![start, current, end].every(Number.isFinite) || end <= start || current < start) {
			throw new Error("ssnc/prgr: unusable progress '" + text(payload) + "'");
		}
		this.track.duration = (end - start) / this.sampleRate;
		this.anchor = { elapsed: (current - start) / this.sampleRate, at: ms, rate: this.anchor.rate };
		return true;
	}

	handleClassic(code, payload, ms) {
		if (this.fresh && code.startsWith("core/")) {
			// First tag of a new bundle: whatever the previous track had and this one lacks must not linger.
			this.track.title = this.track.artist = this.track.album = "";
			this.fresh = false;
		}
		switch (code) {
			case "core/minm": this.track.title = text(payload); return true;
			case "core/asar": this.track.artist = text(payload); return true;
			case "core/asal": this.track.album = text(payload); return true;
			case "core/astm":
				if (payload.length >= 4) { this.track.duration = payload.readUInt32BE(0) / 1000; }
				return true;
			// The id can arrive after the other tags of its track, so a new id only
			// restarts the clock; the text and artwork are overwritten as they come.
			case "core/mper": {
				const id = payload.toString("hex");
				if (id !== this.track.id) {
					this.track.id = id;
					this.anchor = { elapsed: 0, at: ms, rate: this.anchor.rate };
				}
				return true;
			}
			case "ssnc/PICT":
				this.setArtwork(payload);
				return true;
		}
		return false;
	}

	/**
	 * The state to show. Artwork is included only when it changed since the
	 * last snapshot, or when `withArtwork` is set (e.g. for a reloaded browser).
	 */
	snapshot(ms, withArtwork) {
		if (!this.active || !this.track.title) { return { state: "stopped" }; }
		const s = {
			state: this.anchor.rate > 0 ? "playing" : "paused",
			title: this.track.title,
			artist: this.track.artist,
			album: this.track.album,
			duration: this.track.live ? 0 : this.track.duration,
			position: this.positionAt(ms),
			rate: this.anchor.rate
		};
		if (withArtwork || this.artworkDirty) {
			s.artwork = this.track.artwork;
			this.artworkDirty = false;
		}
		return s;
	}
}

module.exports = ShairportState;
