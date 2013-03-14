# torrent-swarm

a torrent swarm implementation that uses the DHT to find peers

	npm install torrent-dht

# usage

``` js
var swarm = require('torrent-swarm');
var nodes = swarm(myInfoHash);

nodes.on('connection', function(connection) {
	// a relevant connection has appeared
	// you should pipe this to a torrent protocol stream
});

nodes.listen();
```