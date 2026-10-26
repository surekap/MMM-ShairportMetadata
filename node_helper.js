/* Magic Mirror
 * Module: MMM-ShairportMetadata
 *
 * By surekap <surekap@gmail.com>
 *
 * MIT Licensed.
 */

const NodeHelper = require("node_helper");
const ShairportState = require("./ShairportState");
const { openPipe, openMqtt } = require("./transports");

// Items of one metadata bundle arrive within a few ms; send them as one state.
const COALESCE_MS = 50;

module.exports = NodeHelper.create({

	start: function() {
		console.log("Starting module: " + this.name);
		this.state = null;
		this.transport = null;
		this.timer = null;
	},

	stop: function() {
		clearTimeout(this.timer);
		if (this.transport) { this.transport.close(); }
	},

	socketNotificationReceived: function(notification, config) {
		if (notification !== "CONFIG") { return; }
		// Several instances of the module share one helper: the first config wins.
		if (!this.transport) { this.connect(config); }
		// A (re)loaded browser needs the full state, artwork included.
		this.send(true);
	},

	connect: function(config) {
		const self = this;
		const log = function(message) { console.log(self.name + ": " + message); };
		this.state = new ShairportState({ sampleRate: config.sampleRate });
		const handlers = {
			log: log,
			onMessage: function(code, payload, ms) {
				if (self.state.handle(code, payload, ms)) { self.sendSoon(); }
			},
			onEnd: function() {
				if (self.state.end()) { self.sendSoon(); }
			}
		};
		try {
			if (config.transport === "pipe") {
				this.transport = openPipe(config.metadataPipe, handlers);
			} else if (config.transport === "mqtt") {
				this.transport = openMqtt({ url: config.mqttUrl, topic: config.mqttTopic }, handlers);
			} else {
				throw new Error("unknown transport '" + config.transport + "', use 'pipe' or 'mqtt'");
			}
		} catch (err) {
			log("cannot start: " + err.message);
		}
	},

	sendSoon: function() {
		if (this.timer) { return; }
		const self = this;
		this.timer = setTimeout(function() {
			self.timer = null;
			self.send(false);
		}, COALESCE_MS);
	},

	send: function(withArtwork) {
		if (!this.state) { return; }
		this.sendSocketNotification("STATE", this.state.snapshot(Date.now(), withArtwork));
	}

});
