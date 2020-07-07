# MMM-ShairportMetadata
A module to integrate AirPlay metadata coming via <a href="https://github.com/mikebrady/shairport-sync">`shairport-sync`</a> into the <a href="https://github.com/MichMich/MagicMirror">MagicMirror</a>. This plugin does not work with video streaming or screen mirroring.

## Preview
![preview](preview.jpg)

This version finally includes a progress bar!

## Using the module
Add `MMM-ShairportMetadata` module to the `modules` array in the `config/config.js` file:
``` javascript
modules: [
  {
    module: 'MMM-ShairportMetadata',
    position: 'bottom_left',
    header: 'Now playing',
    config: {
      metadataPipe: "/tmp/shairport-sync-metadata", // location of pipe with shairport-sync metadata
	  alignment: "center",	// Possible values [left|right|center]. Default: center
    }
  },
]
```

## Integration with shairport-sync
Example configuration for `shairport-sync`:
``` javascript
metadata =
{
		enabled = "yes"; // set to yes to get Shairport Sync to solicit metadata from the source and to pass it on via a pipe
		include_cover_art = "yes"; // set to "yes" to get Shairport Sync to solicit cover art from the source and pass it via the pipe. You must also set "enabled" to "yes".
		pipe_name = "/tmp/shairport-sync-metadata";
		pipe_timeout = 5000; // wait for this number of milliseconds for a blocked pipe to unblock before giving up
//      socket_address = "226.0.0.1"; // if set to a host name or IP address, UDP packets containing metadata will be sent to this address. May be a multicast address. "socket-port" must be non-zero and "enabled" must be set to yes"
//      socket_port = 5555; // if socket_address is set, the port to send UDP packets to
//      socket_msglength = 65000; // the maximum packet size for any UDP metadata. This will be clipped to be between 500 or 65000. The default is 500.
};

```
