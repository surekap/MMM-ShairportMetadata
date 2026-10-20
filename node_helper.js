/* Magic Mirror
 * Module: MMM-ShairportMetadata
 *
 * By surekap <surekap@gmail.com>
 *
 * MIT Licensed.
 */

const NodeHelper = require("node_helper");
const mqtt = require("mqtt");
const ShairportState = require("./ShairportState");

module.exports = NodeHelper.create({

	start: function() {
		console.log("Starting module: " + this.name);
		this.state = new ShairportState();
		this.client = null;
	},

	socketNotificationReceived: function(notification, payload) {
		if (notification !== "CONFIG") { return; }
		if (!this.client) { this.connect(payload); }
		// A (re)loaded browser needs the full state, artwork included.
		this.send(true);
	},

	connect: function(config) {
		const self = this;
		const prefix = config.mqttTopic.replace(/\/+$/, "");

		this.client = mqtt.connect(config.mqttUrl, { reconnectPeriod: 5000 });

		this.client.on("connect", function() {
			console.log(self.name + ": connected to " + config.mqttUrl);
			self.client.subscribe([prefix + "/ssnc/#", prefix + "/core/#"]);
		});

		this.client.on("error", function(err) {
			console.log(self.name + ": MQTT error: " + err.message);
		});

		this.client.on("message", function(topic, payload) {
			const code = topic.slice(prefix.length + 1);
			if (self.state.handle(code, payload, Date.now())) { self.send(false); }
		});
	},

	send: function(withArtwork) {
		this.sendSocketNotification("STATE", this.state.snapshot(Date.now(), withArtwork));
	}

});
