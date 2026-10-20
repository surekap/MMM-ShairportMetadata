# MMM-ShairportMetadata
A module to integrate AirPlay metadata coming via <a href="https://github.com/mikebrady/shairport-sync">`shairport-sync`</a> into the <a href="https://github.com/MichMich/MagicMirror">MagicMirror</a>. This plugin does not work with video streaming or screen mirroring.

The module reads shairport-sync's metadata from an MQTT broker. AirPlay 2 senders such as Apple Music provide the exact playback position, so the progress bar stays in step through pauses, seeks and track changes.

## Preview
![preview](preview.jpg)

## Installation
``` sh
cd ~/MagicMirror/modules
git clone https://github.com/surekap/MMM-ShairportMetadata.git
cd MMM-ShairportMetadata
npm install
```

You also need an MQTT broker, e.g. Mosquitto on the same machine:
``` sh
sudo apt install mosquitto
```

## Using the module
Add `MMM-ShairportMetadata` module to the `modules` array in the `config/config.js` file:
``` javascript
modules: [
  {
    module: 'MMM-ShairportMetadata',
    position: 'bottom_left',
    config: {
      mqttUrl: "mqtt://localhost:1883", // MQTT broker shairport-sync publishes to
      mqttTopic: "shairport",           // must match "topic" in shairport-sync's mqtt settings
      alignment: "center",              // Possible values [left|right|center]. Default: center
      hideAfter: 0,                     // seconds paused before the card hides; 0 = hide only on disconnect
    }
  },
]
```

The card appears when playback starts and hides as soon as the playing device disconnects.

## Integration with shairport-sync
shairport-sync must be built with MQTT support (`shairport-sync -V` lists `mqtt`). Example configuration:
```
metadata =
{
	enabled = "yes";
	include_cover_art = "yes";
};

mqtt =
{
	enabled = "yes";
	hostname = "localhost";
	port = 1883;
	topic = "shairport";
	publish_raw = "yes";     // the module only uses the raw topics
	publish_parsed = "no";
	publish_cover = "no";
};
```

## Troubleshooting
Check that shairport-sync is publishing while something plays:
``` sh
mosquitto_sub -v -t 'shairport/#' -F '%t  %l bytes'
```

To see what the module makes of a session, record one and replay it:
``` sh
mosquitto_sub -t 'shairport/#' -F '%U %t %x' > session.txt
node test/replay.js session.txt
```
