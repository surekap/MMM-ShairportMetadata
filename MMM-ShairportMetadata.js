/* global Log, Module */

/* Magic Mirror
 * Module: MMM-ShairportMetadata
 *
 * By Prateek Sureka <surekap@gmail.com>
 * MIT Licensed.
 */

Module.register("MMM-ShairportMetadata",{

	// Module config defaults.
	defaults: {
		metadataPipe: "/tmp/shairport-sync-metadata",
		alignment: "center"
	},

	// Define start sequence.
	start: function() {
		Log.info("Starting module: " + this.name);

		// Schedule update timer.
		var self = this;
		var progress = [];
		this.sendSocketNotification('CONFIG', this.config);
		setInterval(() => {
			this.updateDom(1000);
		}, 1000);
	},

	socketNotificationReceived: function(notification, payload){
		if(notification === 'DATA'){
			if (payload.hasOwnProperty('image')){
				this.albumart = payload['image'];
			}else{
				this.metadata = payload;
				if (payload.hasOwnProperty('prgr')) {
					this.progress = payload['prgr'].split("/");
				}

			}
			this.updateDom(1000);
		}
	},

	//convert RTP timestamps to seconds (assuming music is 44100hz or 44khz)
	getSec: function(timestamp) {
		return parseInt(timestamp) / 44100;
	},

	secToTime: function(sec) {
		let min = Math.floor(sec / 60);
		var remain = Math.floor((sec % 60));
		remain = (remain.toString().length > 1) ? remain : "0" + (remain);
		return (min + ":" + remain);
	},


	// Override dom generator.
	getDom: function() {
		var wrapper = document.createElement("div");
		wrapper.className = this.config.classes ? this.config.classes : "small";
		alignment = (this.config.alignment == "left") ? "left" : ((this.config.alignment == "right") ? "right" : "center");
		wrapper.setAttribute("style", "text-align:" + alignment + ";")

		if (!this.metadata || (Object.keys(this.metadata).length == 0)){
			wrapper.setAttribute("style", "display:none;");
			return wrapper;
		}

		metadata = document.createElement("div");
		imgtag = document.createElement("img");
		if (this.albumart){
			imgtag.setAttribute('src', this.albumart);
			imgtag.setAttribute('style', "width:200px;height:200px;");
		}
		imgtag.className = 'albumart';
		metadata.appendChild(imgtag);
		//									start 		current			end
		//2:40 = 160 sec
		//"ssnc" "prgr": "1484695203/1484713042/1491729059".
		// end / 44khz - start/44khz = 160 s
		// current /44khz - start/44khz = 0.4 s
		if (this.prgr.length > 0) {
			let prData = this.prgr;
			0.4 / 160 = percentage
			let start   = this.getSec(prData[0]);
			let current = this.getSec(prData[1]);
			let end     = this.getSec(prData[2]);
			let prgrInSec = current - start;
			let songLength = end - start;
			let prgrInPer = (prgrInSec / songLength) * 100;
			prData[1] = prData[1] + 44100; //adds 1 sec of progress
			//sets data for next loop
			this.prgr = prData;
			var progressEl = document.createElement('progress');
			progressEl.setAttribute("value", prgrInSec);
			progressEl.setAttribute("max", songLength);
			progressEl.id = "musicProgress";
			metadata.appendChild(progressEl);

			var prgrLabel = document.createElement("label");
			prgrLabel.setAttribute("for", "musicProgress");
			prgrLabel.innerHTML = this.secToTime(prgrInSec) + " - " + this.secToTime(songLength);
			metadata.appendChild(prgrLabel);
		}




		if (this.metadata['Title'] && this.metadata['Title'].length > 30){
			titletag = document.createElement("marquee");
			titletag.setAttribute('loop', '-1');
		}else{
			titletag = document.createElement("div");
		}

		titletag.innerHTML = (this.metadata['Title']) ? this.metadata['Title'] : "";
		titletag.className = "bright";
		metadata.appendChild(titletag)


		var txt = "";
		if (this.metadata['Artist'] || this.metadata['Album Name']){
			txt = this.metadata['Artist'] + " - " + this.metadata['Album Name']
		}
		if (txt.length > 50){
			artisttag = document.createElement('marquee');
			artisttag.setAttribute("loop", '-1')
		}else{
			artisttag = document.createElement('div');
		}
		artisttag.innerHTML = txt;
		artisttag.className = "xsmall";
		metadata.appendChild(artisttag)

		wrapper.appendChild(metadata);

		return wrapper;
	},

	getStyles: function() {
		return [
			"MMM-SE-Reputation.css",
		];
	},

});
