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
		var player = "Somebody";
		var playing = null;
		this.sendSocketNotification('CONFIG', this.config);
		setInterval(() => {
			this.updateDom(1000);
		}, 1000);
	},

	socketNotificationReceived: function(notification, payload){
		if(notification === 'DATA'){
			console.log("payload");
			console.log(payload);

			if (payload.hasOwnProperty('snam')) {
				console.log("snam? : " + JSON.stringify(payload['snam']));
				this.player = payload['snam'];
			}
			if ((Object.keys(payload).length == 0)) {
			 this.playing = (this.playing == false) ? false : null;
		  }

			if ((Object.keys(payload).length > 0)){
			 this.playing = true
		 }

		 if (payload.hasOwnProperty('pause')) {
		 	console.log("pause? : " + payload['pause']);
		 	this.playing = !payload['pause'];
		 }

			if (payload.hasOwnProperty('image')){
				this.albumart = payload['image'];
			} else {
				this.metadata = payload;
				 if (payload.hasOwnProperty('prgr') && payload['prgr'] != 'undefined') {
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
		var self = this;
		var wrapper = document.createElement("div");
		wrapper.className = this.config.classes ? this.config.classes : "small";
		alignment = (this.config.alignment == "left") ? "left" : ((this.config.alignment == "right") ? "right" : "center");
		wrapper.setAttribute("style", "text-align:" + alignment + ";")

		if (!this.metadata || (Object.keys(this.metadata).length == 0)){
			wrapper.setAttribute("style", "display:none;");
			return wrapper;
		}

		self.data.header = "Somebody is now playing";

		metadata = document.createElement("div");
		imgtag = document.createElement("img");
		if (this.albumart){
			imgtag.setAttribute('src', this.albumart);
			imgtag.setAttribute('style', "width:100px;height:100px;");
		}
		imgtag.className = 'albumart';
		metadata.appendChild(imgtag);

		let break1 = document.createElement('br');
		metadata.appendChild(break1);
		var progressEl = document.createElement('progress');
		progressEl.id = "musicProgress";
		metadata.appendChild(progressEl);

		let break2 = document.createElement('br');
		metadata.appendChild(break2);
		var prgrLabel = document.createElement("label");
		prgrLabel.setAttribute("for", "musicProgress");
		prgrLabel.id = "progressLabel";
		prgrLabel.innerHTML = "0:00 - 0:00";
		metadata.appendChild(prgrLabel);


		if (this.progress && this.progress.length > 0 && this.playing == true) {
			let prData = this.progress;
			let start   = this.getSec(prData[0]);
			let current = this.getSec(prData[1]);
			let end     = this.getSec(prData[2]);
			let prgrInSec = current - start;

			let songLength = end - start;
			prData[1] = (parseInt(prData[1]) + 44100).toString(); //adds 1 sec of progress
			this.progress = prData;

			var progEl = document.getElementById('musicProgress');
			if (prgrInSec > songLength) {
				prgrInSec = songLength;
			}
			progEl.setAttribute("value", prgrInSec);
			progEl.setAttribute("max", songLength);

			var progLbl = document.getElementById('progressLabel');
			prgrLabel.innerHTML = this.secToTime(prgrInSec) + " - " + this.secToTime(songLength);
		}




		if (this.metadata['Title'] && this.metadata['Title'].length > 30){
			// titletag = document.createElement("marquee");
			// titletag.setAttribute('loop', '-1');
			titletag = document.createElement('div');
			titletag.style.fontSize = "10px";
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
			// artisttag = document.createElement('marquee');
			// artisttag.setAttribute("loop", '-1')
			artisttag = document.createElement('div');
			artisttag.style.fontSize = "10px";
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
			"MMM-ShairportMetadata.css",
		];
	},

});
