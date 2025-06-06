// worker.js
const net = require("net");
const msgpack = require("msgpack-stream");

const PORT = 4000;
const HOST = "localhost";

// Nawiązujemy połączenie z masterem
const socket = net.createConnection(PORT, HOST, () => {
  console.log(`WORKER (${HOST}:${PORT}): Połączono z masterem.`);
});

// Tworzymy streamy dla msgpack (encode/decode)
const decoder = msgpack.createDecodeStream();
const encoder = msgpack.createEncodeStream();

// Podpinamy dekoder do socketu (odbieranie danych od mastera)
socket.pipe(decoder);
// Podpinamy encoder, żeby móc wysłać dane do mastera
encoder.pipe(socket);

// Gdy przyjdzie od mastera task:
decoder.on("data", (msg) => {
  // msg = { taskId: <number>, chunkData: "<ciąg cyfr>" }
  if (typeof msg.taskId === "number" && typeof msg.chunkData === "string") {
    const text = msg.chunkData;
    // Inicjalizujemy histogram wystąpień cyfr
    const counts = {
      0: 0,
      1: 0,
      2: 0,
      3: 0,
      4: 0,
      5: 0,
      6: 0,
      7: 0,
      8: 0,
      9: 0,
    };
    console.time();
    // Przechodzimy przez każdy znak w stringu i inkrementujemy counts
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]; // każdy znak to '0'–'9'
      counts[ch]++;
    }
    console.log(
      `WORKER: taskId=${msg.taskId} – zliczono ${text.length} znaków.`
    );
    console.timeEnd();
    console.log("------");

    // Odesłanie wyniku do mastera: { taskId, counts }
    encoder.write({ taskId: msg.taskId, counts });
  }
});

decoder.on("error", (err) => console.error("WORKER: Błąd dekodowania:", err));
