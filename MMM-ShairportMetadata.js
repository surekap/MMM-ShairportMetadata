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
		var self = this;
		self.data.header = "Nothing playing";
		// Schedule update timer.
		var self = this;
		var playing_snam = null;
		var progress = [];
		var playing = null;
		var lastUpdate = new Date().getTime() / 1000;
		this.sendSocketNotification('CONFIG', this.config);
		setInterval(() => {
			this.updateDom(0);
		}, 1000);
	},

	socketNotificationReceived: function(notification, payload){
		if(notification === 'DATA') {
			this.lastUpdate = new Date().getTime() / 1000;

			if ((Object.keys(payload).length == 0)) {
				this.playing = (this.playing == false) ? false : null;
		  }
			if ((Object.keys(payload).length > 0)) {
				this.playing = true
		  }

		 if (payload.hasOwnProperty('pause')) {
		 	this.playing = !payload['pause'];
		 }

			if (payload.hasOwnProperty('image')){
				this.albumart = payload['image'];
			} else {
				this.metadata = payload;
				 if (payload.hasOwnProperty('prgr') && payload['prgr'] != 'undefined') {
					 this.progress = payload['prgr'].split("/");
				 }
				if (this.metadata['Title'] == undefined) {
					// assume disconnected
					this.playing = false;
				}
			}
			this.updateDom(1000);
		}
	},

	//convert RTP timestamps to seconds (assuming music is 44100hz or 44khz)
	//As stated in this section https://github.com/mikebrady/shairport-sync#more-information
	//"The default is 44,100 samples per second / 16 bits"
	getSec: function(timestamp) {
		return parseInt(timestamp) / 44100;
	},

	//convert seconds to normal minute:seconds format like: 201 --> 3:21
	secToTime: function(sec) {
		let min = Math.floor(sec / 60);
		var remain = Math.floor((sec % 60));
		remain = (remain.toString().length > 1) ? remain : "0" + (remain);
		return (min + ":" + remain);
	},

	//determines whether the player should hide if there wasn't any update in last 2 minutes
	//probably a bug then.
	shouldHide: function() {
		let now = new Date().getTime() / 1000;
		return (now > (this.lastUpdate + 2 * 60)) ? true : false;
	},


	// Override dom generator.
	getDom: function() {
		var self = this;
		var wrapper = document.createElement("div");
		wrapper.className = this.config.classes ? this.config.classes : "small";
		alignment = (this.config.alignment == "left") ? "left" : ((this.config.alignment == "right") ? "right" : "center");
		wrapper.setAttribute("style", "text-align:" + alignment + ";")

		if ((!this.metadata || (Object.keys(this.metadata).length == 0)) && (!this.progress && this.playing == false)){
			wrapper.setAttribute("style", "display:none;");
			return wrapper;
		}

		if (this.metadata && Object.keys(this.metadata) && this.metadata['snam'] != undefined) {
			this.playing_snam = this.metadata['snam'];
		}

		if (this.playing_snam != null) {
			self.data.header = `${this.playing_snam} is now playing`;
		} else {
			self.data.header = "Now playing";
		}

		metadata = document.createElement("div");
		imgtag = document.createElement("img");
		if (this.albumart){
			imgtag.setAttribute('src', this.albumart);
			imgtag.setAttribute('style', "width:100px;height:100px;");
		}
		imgtag.className = 'albumart';
		metadata.appendChild(imgtag);

		//create a break below the image
		metadata.appendChild(document.createElement('br'));
		//create the progressbar
		var progressEl = document.createElement('progress');
		progressEl.id = "musicProgress";
		metadata.appendChild(progressEl);

		metadata.appendChild(document.createElement('br'));
		//create the label for the progress
		var prgrLabel = document.createElement("label");
		prgrLabel.setAttribute("for", "musicProgress");
		prgrLabel.id = "progressLabel";
		prgrLabel.innerHTML = "0:00 - 0:00";
		metadata.appendChild(prgrLabel);


		if (this.progress && this.progress.length > 0 && this.playing == true) {
			//get the progress
			let prData = this.progress;
			//get the start, current play frame and the end of the song in seconds
			let start   = this.getSec(prData[0]);
			let current = this.getSec(prData[1]);
			let end     = this.getSec(prData[2]);
			let prgrInSec = current - start;

			let songLength = end - start;
			prData[1] = (parseInt(prData[1]) + 44100).toString(); //adds 1 sec of progress
			this.progress = prData;

			var progEl = progressEl;
			//Make sure that, when there's a bug or something else
			//That the 'progress' won't go past the 'end' of the song.
			if (prgrInSec >= songLength) {
				if (this.shouldHide()) {
					//song is already over and it has been 2 minutes without update
					wrapper.setAttribute("style", "display:none;");
					return wrapper;
				}
				prgrInSec = songLength;
			}
			//update the progressbar
			progEl.setAttribute("value", prgrInSec);
			progEl.setAttribute("max", songLength);

			prgrLabel.innerHTML = this.secToTime(prgrInSec) + " - " + this.secToTime(songLength);
		} else if (this.playing == null && this.progress) { //song was paused
			let prData = this.progress;
			let start   = this.getSec(prData[0]);
			let current = this.getSec(prData[1]);
			let end     = this.getSec(prData[2]);
			let prgrInSec = current - start;

			let songLength = end - start;
			this.progress = prData;

			var progEl = progressEl;
			if (prgrInSec >= songLength) {
				if (this.shouldHide()) {
					//song is already over and it has been 2 minutes without update
					wrapper.setAttribute("style", "display:none;");
					return wrapper;
				}
				prgrInSec = songLength;
			}
			progEl.setAttribute("value", prgrInSec);
			progEl.setAttribute("max", songLength);

			prgrLabel.innerHTML = this.secToTime(prgrInSec) + " - " + this.secToTime(songLength);
		} else { //nothing is playing
			wrapper.setAttribute("style", "display:none;");
			self.data.header = "Nothing playing";
			this.playing_snam = null;
			return wrapper;
		}




		if (this.metadata['Title'] && this.metadata['Title'].length > 30){
			//Because the dom regenerates every second. The marque won't scroll
			//I wasn't able to fix that
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
			//Because the dom regenerates every second. The marque won't scroll
			//I wasn't able to fix that
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

	//Added css file to style the progressbar
	getStyles: function() {
		return [
			"MMM-ShairportMetadata.css",
		];
	},

});
