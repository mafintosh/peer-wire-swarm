var dgram = require('dgram');
var crypto = require('crypto');
var net = require('net');
var events = require('events');
var bncode = require('bncode');

var RANDOM_BYTES = crypto.randomBytes(20*1024);

var DEFAULT_NODES = [{
	host: 'router.bittorrent.com',
	port: 6881
},{
	host: 'router.utorrent.com',
	port: 6881
},{
	host: 'dht.transmissionbt.com',
	port: 6881
}];

var parseNodeInfo = function(compact) {
	var nodes = [];

	for (var i = 0; i < compact.length; i += 26) {
		nodes.push({
			id: compact.slice(i, i+20),
			host: compact[20+i]+'.'+compact[i+21]+'.'+compact[i+22]+'.'+compact[i+23],
			port: compact.readUInt16BE(i+24)
		});
	};

	return nodes;
};

var parsePeerInfo = function(list) {
	return list.map(function(peer) {
		return {
			host: peer[0]+'.'+peer[1]+'.'+peer[2]+'.'+peer[3],
			port: peer.readUInt16BE(4)
		};
	});
};

var randomOffset = 0;

var Swarm = function(infoHash, options, onconnection) {
	if (!(this instanceof Swarm)) return new Swarm(infoHash, options, onconnection);

	events.EventEmitter.call(this);

	if (typeof options === 'function') {
		onconnection = options;
		options = {};
	}

	options = options || {};

	this.infoHash = typeof infoHash === 'string' ? new Buffer(infoHash, 'hex') : infoHash;
	this.maxSize = options.maxSize || 30;
	this.connections = [];

	this._nextPeers = [];
	this._nextNodes = [];
	this._discoveredPeers = {};
	this._discoveredNodes = {};
	this._nodeId = RANDOM_BYTES.slice(randomOffset, randomOffset+20);
	this._reconnects = {};

	randomOffset = (randomOffset + 20) % RANDOM_BYTES.length;

	this._dht = dgram.createSocket('udp4');
	this._t = 0;
	this._sent = {};
	this._bootstrap = options.nodes || DEFAULT_NODES;

	if (onconnection) this.on('connection', onconnection);
};

Swarm.prototype.__proto__ = events.EventEmitter.prototype;

Swarm.prototype.__defineGetter__('nodesFound', function() {
	return Object.keys(this._discoveredNodes).length;
});

Swarm.prototype.__defineGetter__('peersFound', function() {
	return Object.keys(this._discoveredPeers).length;
});

Swarm.prototype.__defineGetter__('queued', function() {
	return this._nextPeers.length;
});

Swarm.prototype.reconnect = function(peer) {
	if (typeof peer === 'string') return this.reconnect({host:peer.split(':')[0], port:parseInt(peer.split(':')[1],10)});
	this._nextPeers.push(peer);
	this._connectPeers();
};

Swarm.prototype.addPeer = function(peer) {
	var id = peer.host+':'+peer.port;

	if (this._discoveredPeers[id]) return this._findPeers();
	this._discoveredPeers[id] = true;
	this._nextPeers.push(peer);
	this._connectPeers();
};

Swarm.prototype.addNode = function(node) {
	var id = node.id || node.host+':'+node.port;

	if (Object.keys(this._discoveredNodes).length >= 2000) return this._findPeers();
	if (this._discoveredNodes[id]) return this._findPeers();

	this._discoveredNodes[id] = {time:Date.now(), node:node};
	this._nextNodes.push(node);
	this._findPeers();
};

Swarm.prototype.listen = function() {
	var self = this;
	var addPeer = this.addPeer.bind(this);
	var addNode = this.addNode.bind(this);

	this._dht.on('message', function(message) {
		try {
			message = bncode.decode(message);
		} catch (err) {
			return;
		}

		var r = message.y.toString() === 'r' && message.r;
		if (!r) return;

		delete self._sent[message.t.toString()];

		var values = r && r.values && parsePeerInfo(r.values);
		if (values) values.forEach(addPeer);

		var nodes = r && r.nodes && parseNodeInfo(r.nodes);
		if (nodes) nodes.forEach(addNode);
	});

	var gc = function() {
		var now = Date.now();

		Object.keys(self._sent).forEach(function(t) {
			var sent = self._sent[t];

			if (now - sent.time < self.tries * 2500) return;
			if (sent.tries >= 5) return delete self._sent[t];

			sent.tries++;
			self._dht.send(sent.message, 0, sent.message.length, sent.node.port, sent.node.host);
		});
	};

	var reset = function() {
		var nodes = self._discoveredNodes;
		var now = Date.now();

		Object.keys(nodes).some(function(id) {
			if (now - nodes[id].time < 90000) return true;
			var node = nodes[id].node;
			delete nodes[id];
			self.addNode(node);
		});
	};

	setInterval(gc, 2000);
	setInterval(reset, 10000);
	this._bootstrap.forEach(addNode);
	return this;
};

Swarm.prototype._connectPeers = function() {
	this._findPeers(); // find more peers!

	if (this.connections.length >= this.maxSize || !this._nextPeers.length) return;

	var self = this;
	var peer = this._nextPeers.pop();
	var socket = net.connect(peer.port, peer.host, {allowHalfOpen:false});
	var id = peer.host+':'+peer.port;

	var onend = function() {
		var index = self.connections.indexOf(socket);
		if (index > -1) self.connections.splice(index, 1);
		self._connectPeers();
	};

	var timeout = setTimeout(socket.destroy.bind(socket), 4000);

	socket.on('error', onend);
	socket.on('end', onend);
	socket.on('close', onend);

	self.connections.push(socket);

	socket.once('connect', function() {
		clearTimeout(timeout);
		self.emit('connection', socket, id, peer);
	});
};

Swarm.prototype._findPeers = function() {
	if (this._nextPeers.length > 2*this.maxSize || !this._nextNodes.length) return;
	if (Object.keys(this._sent).length > Math.max(this.maxSize - this._nextPeers.length, 5)) return;

	var node = this._nextNodes.pop();
	var t = ''+(this._t++);
	var message = bncode.encode({t:t, y:'q', q:'get_peers', a:{id:this._nodeId, info_hash:this.infoHash}});

	this._dht.send(message, 0, message.length, node.port, node.host);
	this._sent[t] = {node:node, message:message, time:Date.now(), tries:1};
};

module.exports = Swarm;