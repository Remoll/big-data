// submaster/Submaster.js
const net = require('net');
const msgpack = require('msgpack-stream');

class Submaster {
  constructor(masterHost, masterPort, listenPort) {
    this.masterHost = masterHost;
    this.masterPort = masterPort;
    this.listenPort = listenPort;
    this.masterSocket = null;
    this.workers = [];
    this.server = null;
    this.init();
  }

  init() {
    this.connectToMaster();
    this.startWorkerServer();
  }

  connectToMaster() {
    this.masterSocket = net.connect(this.masterPort, this.masterHost, () => {
      console.log('SUBMASTER: Connected to MASTER');
    });
    this.masterDecoder = msgpack.createDecodeStream();
    this.masterEncoder = msgpack.createEncodeStream();
    this.masterSocket.pipe(this.masterDecoder).on('data', (msg) => this.handleMasterMsg(msg));
    this.masterEncoder.pipe(this.masterSocket);
  }

  startWorkerServer() {
    this.server = net.createServer((socket) => {
      const decoder = msgpack.createDecodeStream();
      const encoder = msgpack.createEncodeStream();
      socket.pipe(decoder).on('data', (msg) => this.handleWorkerMsg(msg, socket, encoder));
      encoder.pipe(socket);
      this.workers.push({ socket, encoder });
      console.log('SUBMASTER: Worker connected');
    });
    this.server.listen(this.listenPort, () => {
      console.log(`SUBMASTER: Listening for workers on port ${this.listenPort}`);
    });
  }

  // Receive task from master and forward to a worker
  handleMasterMsg(msg) {
    // Simple round-robin or first-available
    const worker = this.workers.shift();
    if (worker) {
      worker.encoder.write(msg);
      this.workers.push(worker);
    } else {
      console.log('SUBMASTER: No available worker to handle task');
    }
  }

  // Receive result from worker and forward to master
  handleWorkerMsg(msg, socket, encoder) {
    this.masterEncoder.write(msg);
  }
}

module.exports = Submaster;

// Example usage (uncomment to run directly):
// const sub = new Submaster('127.0.0.1', 4000, 4100);
