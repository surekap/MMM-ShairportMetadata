// Stands in for MagicMirror's `node_helper` base class, which only exists inside MagicMirror.
module.exports = {
	create: function(definition) {
		return Object.assign({
			name: "MMM-ShairportMetadata",
			sent: [],
			sendSocketNotification: function(notification, payload) {
				this.sent.push([notification, payload]);
			}
		}, definition);
	}
};
