/* Magic Mirror
 * Module: MMM-ShairportMetadata
 *
 * By surekap <surekap@gmail.com>
 *
 * MIT Licensed.
 */

const NodeHelper = require('node_helper');
const spawn = require('child_process').spawn;

module.exports = NodeHelper.create({

    start: function() {
        console.log("Starting module: " + this.name);
    },

    socketNotificationReceived: function(notification, payload) {
        if (notification === "CONFIG") {
			this.config = payload;
			this.getData();
        }
    },
	
	/**
	 * getData
	 * Request data from the supplied URL and broadcast it to the MagicMirror module if it's received.
	 */
    getData: function() {
		if (this.readableStream && this.readableStream != null){
			// Do not start multiple processes
			return;
		}
		
		const self = this;
		self.str_payload = "";
		
		this.readableStream = spawn(__dirname + "/shairport-metadata.sh", [this.config.metadataPipe, __dirname]);
		this.readableStream.stderr.on('data', function(payload){
			console.log("ERR: ", payload.toString());
		});
		
		this.readableStream.on('error', function(err){
			console.log('an error occurred: ', err.toString());
		});
		
		this.readableStream.stdout.on('data', function(payload){
			self.str_payload += payload.toString();
			var lines = self.str_payload.split('\n')
			self.str_payload = lines.pop();
			for(var i = 0; i < lines.length; i++){
				if (lines[i].length == 0){ continue; }
				self.sendSocketNotification("DATA", JSON.parse(lines[i]));
			}
		});
		
		this.readableStream.stdout.on('close', function(){
			self.readableStream.kill();
			self.readableStream = null;
		})
    }
	
});
