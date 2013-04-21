var net = require('net');
var once = require('once');
var dgram = require('dgram');
var bncode = require('bncode');
var crypto = require('crypto');
var compact2string = require('compact2string');
var wireProtocol = require('peer-wire-protocol');
var EventEmitter = require('events').EventEmitter;

var CONNECTION_TIMEOUT = 10000;
var HANDSHAKE_TIMEOUT = 5000;
var RECONNECT = 5000;
var MAX_NODES = 5000;
var BOOTSTRAP_NODES = [
	'dht.transmissionbt.com:6881',
	'router.bittorrent.com:6881',
	'router.utorrent.com:6881'
];

var randomId = function() {
	var bytes = crypto.randomBytes(2000);
	var offset = 0;
	return function() {
		var id = bytes.slice(offset, offset + 20);
		offset = (offset + 20) % bytes.length;
		return id;
	};
}();

var parseNodeInfo = function(compact) {
	try {
		var nodes = [];
		for (var i = 0; i < compact.length; i += 26) {
			nodes.push(compact2string(compact.slice(i+20, i+26)));
		}
		return nodes;
	} catch(err) {
		return [];
	}
};

var parsePeerInfo = function(list) {
	try {
		return list.map(compact2string);
	} catch (err) {
		return [];
	}
};

var remove = function(list, item) {
	var i = list.indexOf(item);
	if (i > -1) list.splice(i, 1);
};

var DHT = function(infoHash) {
	EventEmitter.call(this);

	var self = this;
	var node = function(addr) {
		if (self.nodes[addr]) return;
		if (self.missing) return self.query(addr);
		if (self.queue.length < 50) self.queue.push(addr);
	};
	var peer = function(addr) {
		if (self.peers[addr]) return;
		self.peers[addr] = true;
		self.missing = Math.max(0, self.missing-1);
		self.emit('peer', addr);
	};

	this.nodes = {};
	this.peers = {};
	this.queue = [].concat(BOOTSTRAP_NODES);
	this.nodesCount = 0;
	this.missing = 0;
	this.infoHash = infoHash;
	this.nodeId = randomId();
	this.message = bncode.encode({t:'1',y:'q',q:'get_peers',a:{id:this.nodeId,info_hash:this.infoHash}});

	this.socket = dgram.createSocket('udp4');
	this.socket.on('message', function(message, remote) {
		self.nodes[remote.address+':'+remote.port] = true;

		try {
			message = bncode.decode(message);
		} catch (err) {
			return;
		}

		var r = message && message.r;
		var nodes = r && r.nodes || [];
		var values = r && r.values || [];

		parsePeerInfo(values).forEach(peer);
		parseNodeInfo(nodes).forEach(node);
	});
};

DHT.prototype.__proto__ = EventEmitter.prototype;

DHT.prototype.query = function(addr) {
	if (Object.keys(this.nodes).length > MAX_NODES) return;
	this.socket.send(this.message, 0, this.message.length, addr.split(':')[1], addr.split(':')[0]);
};

DHT.prototype.findPeers = function(num) {
	this.missing += (num || 1);
	while (this.queue.length) this.query(this.queue.pop());
};

DHT.prototype.close = function() {
	this.socket.close();
};

var Swarm = function(infoHash, peerId, options) {
	if (!(this instanceof Swarm)) return new Swarm(infoHash, peerId, options);
	options = options || {};
	var self = this;

	this.infoHash = typeof infoHash === 'string' ? new Buffer(infoHash, 'hex') : infoHash;
	this.peerId = typeof peerId === 'string' ? new Buffer(peerId) : peerId;
	this.wires = [];
	this.connections = [];

	this.dht = new DHT(this.infoHash);
	this.maxSize = options.maxSize || 30;
	this.queue = [];
	this.verified = {};

	this.downloaded = 0;
	this.uploaded = 0;

	this.dht.on('peer', function(peer) {
		self.queue.push(peer);
		self.connect();
	});
};

Swarm.prototype.__proto__ = EventEmitter.prototype;

Swarm.prototype.__defineGetter__('queued', function() {
	return this.queue.length;
});

Swarm.prototype.connect = function() {
	if (!this.queue.length || this.connections.length >= this.maxSize) return;

	var self = this;
	var addr = this.queue.shift();
	var connected = false;
	var socket = net.connect(addr.split(':')[1], addr.split(':')[0]);
	var wire = wireProtocol();

	wire.address = addr;
	socket.pipe(wire).pipe(socket);
	this.connections.push(socket);

	wire.on('download', function(bytes) {
		self.downloaded += bytes;
		self.emit('download', bytes);
	});
	wire.on('upload', function(bytes) {
		self.uploaded += bytes;
		self.emit('upload', bytes);
	});

	var reconnect = function() {
		self.queue.push(addr);
		self.connect();
	};

	var onclose = once(function() {
		if (!self.dht.missing && self.queued < self.maxSize) self.dht.findPeers();
		if (self.verified[addr] && !connected) setTimeout(reconnect, RECONNECT * ++self.verified[addr]);
		socket.destroy();
		remove(self.wires, wire);
		remove(self.connections, socket);
		self.connect();
	});

	socket.on('close', onclose);
	socket.on('error', onclose);
	socket.on('end', onclose);

	var timeout = setTimeout(onclose, CONNECTION_TIMEOUT);

	socket.once('connect', function() {
		clearTimeout(timeout);
		timeout = setTimeout(onclose, HANDSHAKE_TIMEOUT);
		connected = true;
		self.verified[addr] = 1;
		self.emit('connection', socket);
		wire.once('handshake', function(infoHash, peerId) {
			clearTimeout(timeout);
			if (infoHash.toString('hex') !== self.infoHash.toString('hex')) return onclose();

			wire.setKeepAlive();
			wire.on('finish', function() {
				onclose();
				setTimeout(reconnect, RECONNECT);
			});

			self.wires.push(wire);
			self.emit('wire', wire);
		});
		wire.handshake(self.infoHash, self.peerId);
	});
};

Swarm.prototype.size = function(maxSize) {
	this.maxSize = maxSize || this.maxSize;
	this.connect();
	return this.maxSize;
};

Swarm.prototype.listen = function() {
	this.dht.findPeers(this.maxSize);
};

Swarm.prototype.__defineGetter__('nodesFound', function() {
	return Object.keys(this.dht.nodes).length;
});

Swarm.prototype.__defineGetter__('peersFound', function() {
	return Object.keys(this.dht.peers).length;
});

module.exports = Swarm;