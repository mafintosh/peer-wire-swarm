# peer-wire-swarm

a peer swarm implementation

	npm install peer-wire-swarm

# usage

``` js
var wireSwarm = require('peer-wire-swarm');
var swarm = wireSwarm(myInfoHash, myPeerId);

swarm.on('wire', function(wire) {
	// a relevant peer-wire-protocol as appeared
	// see the peer-wire-protocol module for more info

	wire.on('unchoke', function() {
		// we are now unchoked
	});

	swarm.wires // <- list of all connected wires
});

swarm.add('127.0.0.1:42442'); // add a peer
swarm.remove('127.0.0.1:42244'); // remove a peer

swarm.pause();  // pause the swarm (stops adding connections)
swarm.resume(); // resume the swarms

swarm.listen(6881); // listen for incoming connections (optional)
```
