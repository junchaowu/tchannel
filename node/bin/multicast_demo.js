#!/usr/bin/env node

// -- structure to track outstanding "operations"

function Oper(opts, send) {
    var self = this;
    self.id = 0;
    self.ops = {};
    self.max = opts.max;
    self.timeout = opts.timeout;
    self.nextTime = Infinity;
    self.timer = null;
    self.send = send;
}

Oper.prototype.finish = function finish(id, err, result) {
    var self = this;
    var op = self.ops[id];
    if (op) {
        op.finish = Date.now();
        delete self.ops[id];
        op.callback(err, op, result);
        // TODO: only reset timer if needed
        self.onTimeout();
    }
};

Oper.prototype.add = function add(callback) {
    var self = this;
    var id = self.nextId();
    if (self.ops[id]) {
        callback(new Error('duplicate operation'));
        return;
    }
    var now = Date.now();
    var op = self.ops[id] = {
        id: id,
        start: now,
        finish: 0,
        deadline: now + self.timeout,
        callback: callback
    };
    self.updateTimer(op.deadline);
    return op;
};

Oper.prototype.nextId = function nextId() {
    var self = this;
    self.id = (self.id + 1) % self.max;
    return self.id;
};

Oper.prototype.updateTimer = function updateTimer(nextTime) {
    var self = this;
    if (nextTime < self.nextTime) {
        self.nextTime = nextTime;
        var timeout = Math.max(0, self.nextTime - Date.now());
        clearTimeout(self.timer);
        self.timer = setTimeout(onTimeout, timeout);
    }
    function onTimeout() {
        self.onTimeout();
    }
};

Oper.prototype.onTimeout = function onTimeout() {
    var self = this;
    var ids = Object.keys(self.ops);
    var nextTime = self.nextTime = Infinity;
    for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        var op = self.ops[id];
        if (op.deadline < Date.now()) {
            delete self.ops[id];
            op.callback(new Error('timed out'), op, null);
        } else {
            nextTime = Math.min(nextTime, op.deadline);
        }
    }
    self.updateTimer(nextTime);
};

// -- frame read/write definitions

var CRC32C = require("sse4_crc32").calculate;
var bufrw = require('bufrw');

// note assumes that buffer being read is rooted @0
var ChecksumPrior = {
    byteLength: function checksumLength() {
        return bufrw.UInt32BE.byteLength();
    },
    writeInto: function writePriorChecksum(obj, buffer, offset) {
        var checksum = CRC32C(buffer.slice(0, offset));
        return bufrw.UInt32BE.writeInto(checksum, buffer, offset);
    },
    readFrom: function readPriorChecksum(obj, buffer, offset) {
        var res = bufrw.UInt32BE.readFrom(buffer, offset);
        if (!res.err) {
            var expected = res.value;
            var got = CRC32C(buffer.slice(0, offset));
            if (got !== expected) {
                return bufrw.ReadResult.rangedError(new Error(
                    'checksum mismatch, expected ' + expected + ' got ' + got
                ), offset, res.offset);
            }
        }
        return res;
    }
};

// type:1 {body} checksum:4
var BodyCases = {};
var FrameRW = bufrw.Struct([
    {call: bufrw.Switch(bufrw.UInt8, BodyCases, {
        valKey: 'type',
        dataKey: 'body',
        structMode: true
    })},
    {name: 'checksum', call: ChecksumPrior}
]);

// A normal string message body
var MessType = 1;
BodyCases[MessType] = bufrw.Struct({
    msg: bufrw.str2
});

// --- main program

var dgram = require('dgram');

var argv = require('minimist')(process.argv.slice(2));
var split2 = require('split2');

if (argv._.length < 2) {
    console.error('usage chatter port address [address [...]]');
    process.exit(1);
}
var port = parseInt(argv._[0]);
if (!port) {
    console.error('invalid port');
    process.exit(1);
}
var addresses = argv._.slice(1);

var socket = dgram.createSocket('udp4', onMessage);
socket.bind(port, bound);

var ready = false;

function handleFrame(remoteAddr, frame) {
    switch (frame.type) {

    case MessType:
        console.log('%s:%s> %s', remoteAddr.address, remoteAddr.port, frame.body.msg);
        break;

    }
}

function onMessage(buf, rinfo) {
    bufrw.fromBufferResult(FrameRW, buf).toCallback(function parsed(err, frame) {
        if (err) {
            console.log('READ ERROR from %s:%s> %s', rinfo.address, rinfo.port, bufrw.formatError(err));
        } else {
            handleFrame(rinfo, frame);
        }
    });
}

function onStdinData(line) {
    var msg = line.replace(/^\s+|\s+$/g, '');
    send(MessType, {msg: msg});
}

function onStdinEnd() {
    socket.close();
}

function bound() {
    ready = true;
    for (var i = 0; i < addresses.length; i++) {
        socket.addMembership(addresses[i]);
    }
    var lines = process.stdin.pipe(split2());
    lines.on('data', onStdinData);
    lines.on('end', onStdinEnd);
}

function send(type, body) {
    if (!ready) {
        throw new Error('cannot send, not ready');
    }
    var frame = {
        type: type,
        body: body,
        checksum: 0
    };
    bufrw.toBufferResult(FrameRW, frame).toCallback(function wrote(err, buf) {
        if (err) {
            console.log('WRITE ERROR> %j\n%s', frame, bufrw.formatError(err, {color: true}));
        } else {
            for (var i = 0; i < addresses.length; i++) {
                socket.send(buf, 0, buf.length, port, addresses[i]);
            }
        }
    });
}