var net = require('net');
var fifo = require('fifo');
var once = require('once');
var peerWireProtocol = require('peer-wire-protocol');
var EventEmitter = require('events').EventEmitter;

var HANDSHAKE_TIMEOUT = 5000;
var RECONNECT_TIMEOUT = 5000;

var toBuffer = function(str, encoding) {
	return Buffer.isBuffer(str) ? str : new Buffer(str, encoding);
};

var toAddress = function(wire) {
	if (typeof wire === 'string') return wire;
	return wire.remoteAddress;
};

var onwire = function(connection, onhandshake) {
	var wire = peerWireProtocol();

	connection.on('end', function() {
		connection.destroy();
	});
	connection.on('error', function() {
		connection.destroy();
	});
	connection.on('close', function() {
		wire.end();
	});

	var destroy = function() {
		connection.destroy();
	};
	var timeout = setTimeout(destroy, HANDSHAKE_TIMEOUT);

	wire.once('handshake', function(infoHash, peerId) {
		clearTimeout(timeout);
		onhandshake(infoHash, peerId);
	});

	connection.pipe(wire).pipe(connection);
	return wire;
};

var pools = {};

var leave = function(port, swarm) {
	if (!pools[port]) return;
	delete pools[port].swarms[swarm.infoHash.toString('hex')];

	if (Object.keys(pools[port].swarms).length) return;
	pools[port].server.close();
	delete pools[port];
};

var join = function(port, swarm) {
	var pool = pools[port];

	if (!pool) {
		var swarms = {};
		var server = net.createServer(function(connection) {
			var wire = onwire(connection, function(infoHash, peerId) {
				var swarm = swarms[infoHash.toString('hex')];
				if (!swarm) return connection.destroy();
				swarm._onincoming(connection, wire);
			});
		});

		server.listen(port, function() {
			pool.listening = true;
			Object.keys(swarms).forEach(function(infoHash) {
				swarms[infoHash].emit('listening');
			});
		});

		pool = pools[port] = {
			server: server,
			swarms: swarms,
			listening: false
		};
	}

	var infoHash = swarm.infoHash.toString('hex');

	if (pool.listening) {
		process.nextTick(function() {
			swarm.emit('listening');
		});
	}
	if (pool.swarms[infoHash]) {
		process.nextTick(function() {
			swarm.emit('error', new Error('port and info hash already in use'));
		});
		return;
	}

	pool.swarms[infoHash] = swarm;
};

var Swarm = function(infoHash, peerId, options) {
	if (!(this instanceof Swarm)) return new Swarm(infoHash, peerId, options);
	EventEmitter.call(this);

	options = options || {};

	this.port = 0;
	this.size = options.size || 60;

	this.infoHash = toBuffer(infoHash, 'hex');
	this.peerId = toBuffer(peerId, 'utf-8');

	this.downloaded = 0;
	this.uploaded = 0;
	this.connections = [];
	this.wires = [];

	this._destroyed = false;
	this._queue = fifo();
	this._peers = {};
};

Swarm.prototype.__proto__ = EventEmitter.prototype;

Swarm.prototype.__defineGetter__('queued', function() {
	return this._queue.length;
});

Swarm.prototype.prioritize = function(addr, bool) {
	if (addr && typeof addr === 'object') return this.prioritize(addr.remoteAddress);
	if (!this._peers[addr]) return;
	this._peers[addr].priority = bool !== false;
};

Swarm.prototype.unprioritize = function(addr) {
	this.prioritize(addr, false);
};

Swarm.prototype.add = function(addr) {
	if (this._destroyed || this._peers[addr]) return;

	this._peers[addr] = {
		node: this._queue.push(addr),
		wire: null,
		timeout: null,
		reconnect: false,
		priority: false,
		retries: 0,
	};

	this._drain();
};

Swarm.prototype.remove = function(addr) {
	this._remove(toAddress(addr));
	this._drain();
};

Swarm.prototype.listen = function(port, onlistening) {
	if (onlistening) this.once('listening', onlistening);
	this.port = port;
	join(this.port, this);
};

Swarm.prototype.destroy = function() {
	this._destroyed = true;

	var self = this;
	Object.keys(this._peers).forEach(function(addr) {
		self._remove(addr);
	});

	leave(this.port, this);
	process.nextTick(function() {
		self.emit('close');
	});
};

Swarm.prototype._remove = function(addr) {
	var peer = this._peers[addr];
	if (!peer) return;
	delete this._peers[addr];
	this._queue.remove(peer.node);
	if (peer.timeout) clearTimeout(peer.timeout);
	if (peer.wire) peer.wire.destroy();
};

Swarm.prototype._drain = function() {
	if (this.connections.length >= this.size) return;
	if (!this._queue.length) return;

	var self = this;
	var addr = this._queue.shift();
	var peer = this._peers[addr];

	if (!peer) return;

	var parts = addr.split(':');
	var connection = net.connect(parts[1], parts[0]);
	if (peer.timeout) clearTimeout(peer.timeout);

	var wire = onwire(connection, function(infoHash) {
		if (infoHash.toString('hex') !== self.infoHash.toString('hex')) return connection.destroy();
		peer.reconnect = true;
		peer.retries = 0;
		self._onwire(connection, wire);
	});

	var repush = function() {
		peer.node = peer.priority ? self._queue.unshift(addr) : self._queue.push(addr);
		self._drain();
	};

	wire.on('end', function() {
		if (!peer.reconnect || self._destroyed) return self._remove(addr);
		peer.timeout = setTimeout(repush, peer.retries++ * RECONNECT_TIMEOUT);
	});

	peer.wire = wire;
	self._onconnection(connection);

	wire.remoteAddress = addr;
	wire.handshake(this.infoHash, this.peerId);
};

Swarm.prototype._onincoming = function(connection, wire) {
	wire.remoteAddress = connection.address().address + ':' + connection.address().port;
	wire.handshake(this.infoHash, this.peerId);

	this._onconnection(connection);
	this._onwire(connection, wire);
};

Swarm.prototype._onconnection = function(connection) {
	var self = this;

	connection.once('close', function() {
		self.connections.splice(self.connections.indexOf(connection), 1);
		self._drain();
	});

	this.connections.push(connection);
};

Swarm.prototype._onwire = function(connection, wire) {
	var self = this;

	wire.on('download', function(downloaded) {
		self.downloaded += downloaded;
		self.emit('download', downloaded);
	});

	wire.on('upload', function(uploaded) {
		self.uploaded += uploaded;
		self.emit('upload', uploaded);
	});

	var cleanup = once(function() {
		self.wires.splice(self.wires.indexOf(wire), 1);
		connection.destroy();
	});

	connection.on('close', cleanup);
	connection.on('error', cleanup);
	connection.on('end', cleanup);
	wire.on('end', cleanup);

	this.wires.push(wire);
	this.emit('wire', wire, connection);
};

module.exports = Swarm;