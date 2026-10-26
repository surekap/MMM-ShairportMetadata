/* global Log, Module */

/* Magic Mirror
 * Module: MMM-ShairportMetadata
 *
 * By Prateek Sureka <surekap@gmail.com>
 * MIT Licensed.
 *
 * Forked by ChielChiel
 * Who made the progressbar
 *
 * The playback position is an anchor (`baseSec` seconds into the track at time
 * `anchor`, advancing at `rate`) rather than a counter, so the bar is right
 * however often the page is drawn. Design from pull request #21 by Dnovak043.
 *
 * The header is MagicMirror's own: set `header` on the module, or leave it
 * out. The module never changes it; while nothing plays the whole module,
 * header included, is hidden.
 */

Module.register("MMM-ShairportMetadata", {

	// Module config defaults.
	defaults: {
		transport: "pipe",                              // "pipe" or "mqtt"
		metadataPipe: "/tmp/shairport-sync-metadata",   // transport "pipe": pipe_name of shairport-sync
		mqttUrl: "mqtt://localhost:1883",               // transport "mqtt": the broker shairport-sync publishes to
		mqttTopic: "shairport",                         // transport "mqtt": the topic set in shairport-sync
		alignment: "center",                            // left, center or right
		hideAfter: 0,                                   // seconds paused before hiding; 0 = hide only when playback ends
		sampleRate: 44100                               // RTP clock of the progress classic AirPlay reports
	},

	// Define start sequence.
	start: function() {
		Log.info("Starting module: " + this.name);
		this.model = { state: "stopped" };
		this.albumart = null;
		this.badArt = null;         // artwork the browser could not decode
		this.baseSec = 0;
		this.anchor = 0;
		this.rate = 0;
		this.songLen = 0;
		this.lastUpdate = this.now();
		this.ui = null;
		this.domReady = false;
		this.visible = null;        // unknown until MagicMirror has created the DOM
		this.timer = null;
		this.sendSocketNotification("CONFIG", this.config);
	},

	notificationReceived: function(notification) {
		if (notification === "DOM_OBJECTS_CREATED") {
			this.domReady = true;
			this.render(0);
		}
	},

	// payload: { state: "stopped" } or
	// { state: "playing"|"paused", title, artist, album, duration, position, rate, artwork? }
	// with times in seconds; artwork (a data URL, or null) only when it changed.
	socketNotificationReceived: function(notification, payload) {
		if (notification !== "STATE") { return; }
		this.lastUpdate = this.now();
		if (Object.prototype.hasOwnProperty.call(payload, "artwork")) {
			this.albumart = payload.artwork || null;
		}
		if (payload.state === "stopped") {
			this.model = { state: "stopped" };
		} else {
			this.model = payload;
			this.rate = payload.rate > 0 ? payload.rate : 0;
			this.baseSec = payload.position || 0;
			this.songLen = payload.duration || 0;
			this.anchor = this.now();
		}
		this.render(1000);
	},

	now: function() {
		return new Date().getTime() / 1000;
	},

	// Seconds into the track, right now.
	elapsedNow: function() {
		const e = this.baseSec + (this.now() - this.anchor) * this.rate;
		return Math.max(0, this.songLen > 0 ? Math.min(e, this.songLen) : e);
	},

	// convert seconds to normal minute:seconds format like: 201 --> 3:21
	secToTime: function(sec) {
		const s = Math.max(0, Math.floor(sec));
		const remain = s % 60;
		return Math.floor(s / 60) + ":" + (remain < 10 ? "0" : "") + remain;
	},

	// Whether to give up on the card: paused for longer than hideAfter, or playing
	// 2 minutes past the end of the track with no news (the sender went and we missed it).
	shouldHide: function() {
		const quiet = this.now() - this.lastUpdate;
		if (this.rate > 0) {
			const ended = this.songLen > 0 && this.baseSec + (this.now() - this.anchor) * this.rate >= this.songLen;
			return ended && quiet > 120;
		}
		return this.config.hideAfter > 0 && quiet > this.config.hideAfter;
	},

	// Brings the card in line with the state. Only the changed parts of the
	// DOM are touched; it is never rebuilt.
	render: function(speed) {
		if (!this.domReady) { return; }
		if (this.model.state === "stopped") {
			this.setVisible(false, speed);
			return;
		}
		const ui = this.getUi();
		ui.title.textContent = this.model.title || "";
		ui.artist.textContent = [this.model.artist, this.model.album].filter(Boolean).join(" - ");
		if (this.albumart && this.albumart !== this.badArt) {
			if (ui.art.getAttribute("src") !== this.albumart) { ui.art.src = this.albumart; }
		} else {
			ui.art.removeAttribute("src");
		}
		this.update();
		this.setVisible(true, speed);
	},

	// The progress bar and the times; runs every second while the card is shown.
	update: function() {
		const ui = this.getUi();
		const hasLength = this.songLen > 0;
		ui.progress.hidden = !hasLength;
		ui.time.hidden = !hasLength;
		if (!hasLength) { return; }
		const elapsed = this.elapsedNow();
		ui.progress.max = this.songLen;
		ui.progress.value = elapsed;
		ui.time.textContent = this.secToTime(elapsed) + " - " + this.secToTime(this.songLen) + (this.rate > 0 ? "" : " (paused)");
	},

	onTimer: function() {
		if (this.shouldHide()) {
			this.model = { state: "stopped" };
			this.render(1000);
			return;
		}
		this.update();
	},

	// Shows or hides the whole module (header included) with MagicMirror's own
	// lock, so that it cooperates with modules like MMM-Pages.
	setVisible: function(visible, speed) {
		if (visible === this.visible) { return; }
		this.visible = visible;
		const lock = { lockString: this.identifier };
		if (visible) {
			this.show(speed, function() {}, lock);
			this.timer = setInterval(() => { this.onTimer(); }, 1000);
		} else {
			this.hide(speed, function() {}, lock);
			clearInterval(this.timer);
			this.timer = null;
		}
	},

	element: function(tag, className, parent) {
		const e = document.createElement(tag);
		e.className = className;
		parent.appendChild(e);
		return e;
	},

	getUi: function() {
		if (this.ui) { return this.ui; }
		const wrapper = document.createElement("div");
		wrapper.className = this.config.classes ? this.config.classes : "small";
		wrapper.style.textAlign = (this.config.alignment === "left" || this.config.alignment === "right") ? this.config.alignment : "center";
		const card = this.element("div", "card", wrapper);
		const art = this.element("img", "albumart", this.element("div", "art", card));
		art.alt = "";
		// Corrupt artwork would show as a broken-image box; hide it instead, and do not try it again.
		art.addEventListener("error", () => {
			this.badArt = art.getAttribute("src");
			art.removeAttribute("src");
		});
		const progress = this.element("progress", "progress", this.element("div", "bar", card));
		const time = this.element("div", "time", card);
		const title = this.element("div", "title bright", card);
		const artist = this.element("div", "artist xsmall", card);
		this.ui = { wrapper: wrapper, art: art, progress: progress, time: time, title: title, artist: artist };
		return this.ui;
	},

	// Override dom generator.
	getDom: function() {
		return this.getUi().wrapper;
	},

	//Added css file to style the progressbar
	getStyles: function() {
		return [
			"MMM-ShairportMetadata.css",
		];
	},

});
