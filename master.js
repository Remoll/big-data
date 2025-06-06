// master.js
const fs = require("fs");
const path = require("path");
const net = require("net");
const readline = require("readline");
const msgpack = require("msgpack-stream");
const { EventEmitter } = require("events");
const http = require("http");
const url = require("url");
const { spawn } = require("child_process");
const { PORT, SOURCE_FILE, HTTP_PORT } = require("./params/const");
const { factualBussyWorkers, workersAll } = require("./params/reactive");

let workers = []; // lista wolnych workerów: { socket, encoder, idWorker }
let queue = [];
let CHUNK_SIZE = 10; // 10 MiB na chunk

// EventEmitter, który wywoła assignTasks, gdy pojawi się nowe zadanie lub wolny worker
const coordinator = new EventEmitter();

// Obiekt do sumowania wyników od workerów (histogram cyfr od '0' do '9')
let countsSum = null;

// Liczniki runów
let totalChunks = 0; // ile zadań ogółem (po podziale pliku)
let receivedChunks = 0; // ile już przyszło od workerów

// Flagi sterujące
let hasWorker = false; // czy jest przynajmniej jeden podłączony worker
let isProcessing = false; // czy trwa aktualnie przetwarzanie (run)
let rl = null; // readline interface dla stdin

// ---------------------------------------------
// 1) FUNKCJA: wczytaj big.txt i podziel w locie na chunk'i ~CHUNK_SIZE każdy
// ---------------------------------------------
async function generateChunksFromFile(filePath, chunkSize) {
  return new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(filePath, {
      highWaterMark: chunkSize,
    });
    let chunkId = 0;
    console.log("START");
    console.time();
    factualBussyWorkers.length = 0;
    readStream.on("data", (buffer) => {
      const chunkStr = buffer.toString("utf8");
      queue.push({ id: chunkId++, data: chunkStr });
      coordinator.emit("taskQueued");
    });

    readStream.once("end", () => {
      // console.log(`MASTER: Podział pliku zakończony – utworzono ${chunkId} chunków.`);
      resolve(chunkId);
    });

    readStream.once("error", (err) => {
      console.error("MASTER: Błąd przy czytaniu pliku:", err);
      reject(err);
    });
  });
}

// ---------------------------------------------
// 2) FUNKCJA: przydzielanie zadań do wolnych workerów
// ---------------------------------------------
function assignTasks() {
  console.log("!!!!     assignTasks run     !!!!");
  // console.log('workers: ', workers);
  // Usuwamy z puli wolnych tych, którzy są wyłączeni
  workers = workers.filter((w) => w.enabled);
  // console.log('workers: ', workers);
  // console.log('workers: ', workers.socket);

  while (queue.length > 0 && workers.length > 0) {
    const task = queue.shift(); // { id, data }
    const workerObj = workers.shift(); // { socket, encoder, idWorker, enabled }
    const { encoder, idWorker } = workerObj;

    console.log("factualBussyWorkers: ", factualBussyWorkers);
    console.log("idWorker: ", idWorker);

    if (!factualBussyWorkers.includes(idWorker)) {
      factualBussyWorkers.push(idWorker);
    }

    // console.log('idWorker: ', idWorker);
    // Wysyłamy do workera obiekt { taskId, chunkData }
    encoder.write({ taskId: task.id, chunkData: task.data });
    // Dajemy znać, które zadanie idzie do którego workera:
    // console.log(`MASTER: wysłano fragment #${task.id} do workera #${idWorker}`);
  }
}
coordinator.on("taskQueued", assignTasks);

// ---------------------------------------------
// 3) FUNKCJA: obsługa wiadomości od workerów
// ---------------------------------------------
function handleWorkerMsg(msg, socket) {
  // msg = { taskId, counts: { '0': x, …, '9': z } }
  if (msg && typeof msg.taskId === "number" && msg.counts) {
    receivedChunks++;
    // console.log(`MASTER: otrzymano wynik od workera (taskId=${msg.taskId})`);

    // Sumujemy każdą cyfrę do countsSum
    for (let d = 0; d <= 9; d++) {
      const key = d.toString();
      countsSum[key] += msg.counts[key] || 0;
    }

    // Gdy wszystkie chunk'i już obrobione → pokaż finalny histogram i zakończ run
    if (receivedChunks === totalChunks) {
      // console.log('MASTER: Wszystkie fragmenty przetworzone. Oto końcowy wynik:');

      // Reset stanu, aby umożliwić kolejne runy
      // console.log('resetState');
      console.log(
        "MASTER: Faktycznie użytych workerów: ",
        factualBussyWorkers.length
      );

      console.timeEnd();

      resetState();
      promptForRun();
    }

    // Zwracamy workera do puli wolnych
    const readyWorker = findWorkerBySocket(socket);
    if (readyWorker) {
      workers.push(readyWorker);
      coordinator.emit("taskQueued");
    }
  }
}

// Pomocnicza: szuka obiektu workerObj po socket
function findWorkerBySocket(sock) {
  return workersAll.find((w) => w.socket === sock);
}

// ---------------------------------------------
// 4) Funkcja do uruchamiania całego „run”
// ---------------------------------------------
async function startProcessingRun() {
  if (!hasWorker) {
    console.log("MASTER: Nie ma podłączonych workerów – nie można rozpocząć.");
    return;
  }
  if (isProcessing) {
    console.log("MASTER: Przetwarzanie już trwa – poczekaj na zakończenie.");
    return;
  }
  // Ustaw flagi
  isProcessing = true;
  queue = [];
  workers = workersAll.map((w) => w); // wszyscy workerzy stają się wolni na start
  receivedChunks = 0;
  // Inicjalizujemy histogram dla cyfr
  countsSum = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 };

  // console.log('MASTER: Rozpoczynam podział pliku i rozsyłanie zadań...');
  try {
    totalChunks = await generateChunksFromFile(
      SOURCE_FILE,
      CHUNK_SIZE * 1024 * 1024
    );

    console.log(`MASTER: Aktywnych workerów ${workers.length}.`);
    console.log(`MASTER: Łącznie utworzono ${totalChunks} zadań.`);
    console.log(`MASTER: Rozmiar zadania ${CHUNK_SIZE} MB.`);

    // Jeżeli plik był pusty
    if (totalChunks === 0) {
      console.log("MASTER: Brak danych do przetworzenia.");
      resetState();
      promptForRun();
    }

    // assignTasks zostanie wywołane przez eventy „taskQueued” w generateChunksFromFile
  } catch (err) {
    console.error("MASTER: Błąd podczas generowania chunków:", err);
    resetState();
    promptForRun();
  }
}

// ---------------------------------------------
// 5) Reset stanu po zakończonym run
// ---------------------------------------------
function resetState() {
  isProcessing = false;
  totalChunks = 0;
  receivedChunks = 0;
  queue = [];
  // Nie usuwamy workerów – pozostają podłączeni
  console.log("MASTER: Stan zresetowany. Możesz ponownie wpisać „run”.");
}

// ---------------------------------------------
// 6) Prompt do odczytu komendy „run” od użytkownika
// ---------------------------------------------
function promptForRun() {
  if (!rl) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'Type "run" and press Enter to start processing> ',
    });
    rl.on("line", (line) => {
      const cmd = line.trim().toLowerCase();
      if (cmd === "run") {
        startProcessingRun();
      } else if (cmd.startsWith("1 ")) {
        const id = parseInt(cmd.split(" ")[1], 10);
        setWorkerEnabled(id, true);
      } else if (cmd.startsWith("2 ")) {
        const id = parseInt(cmd.split(" ")[1], 10);
        setWorkerEnabled(id, false);
      } else if (cmd === "list") {
        console.log("Lista workerów:");
        workersAll.forEach((w) => {
          console.log(`#${w.idWorker} - ${w.enabled ? "ON" : "OFF"}`);
        });
      } else {
        console.log(
          "Nieznana komenda. Wpisz „run”, „1 <id>”, „2 <id>” lub „list”."
        );
      }
      rl.prompt();
    });
  }
  rl.prompt();
}

// ---------------------------------------------
// 7) URUCHOMIENIE SERWERA TCP i obsługa połączeń workerów
// ---------------------------------------------
const server = net.createServer();

server.on("connection", (socket) => {
  // Utwórz strumienie msgpack: decode i encode
  const decoder = msgpack.createDecodeStream();
  const encoder = msgpack.createEncodeStream();

  socket.pipe(decoder).on("data", (msg) => handleWorkerMsg(msg, socket));
  encoder.pipe(socket);

  // Nowy worker otrzymuje unikalne id oraz flagę enabled
  const idWorker = workersAll.length;
  const workerObj = { socket, encoder, idWorker, enabled: true };

  workersAll.push(workerObj);
  workers.push(workerObj); // na początku jest wolny
  hasWorker = true; // teraz jest co najmniej jeden worker

  console.log(`MASTER: Worker #${idWorker} podłączył się.`);
  // Jeśli to pierwszy worker, włączamy prompt do wpisania „run”
  if (workersAll.length === 1) {
    console.log("MASTER: Wpisz „run” i naciśnij Enter, aby rozpocząć.");
    promptForRun();
  }
  // Jeżeli wciąż trwa poprzedni run, przydziel zadania (jeśli są)
  coordinator.emit("taskQueued");
});

// --- Zarządzanie workerami: enable/disable ---
function setWorkerEnabled(id, enabled) {
  const worker = workersAll.find((w) => w.idWorker === id);
  if (!worker) {
    console.log(`MASTER: Worker #${id} nie istnieje.`);
    return;
  }
  worker.enabled = enabled;
  if (!enabled) {
    // Usuwamy z puli wolnych, jeśli tam jest
    const idx = workers.indexOf(worker);
    if (idx !== -1) workers.splice(idx, 1);
    console.log(`MASTER: Worker #${id} WYŁĄCZONY.`);
  } else {
    // Dodajemy do puli wolnych, jeśli nie jest zajęty
    if (!workers.includes(worker)) workers.push(worker);
    console.log(`MASTER: Worker #${id} WŁĄCZONY.`);
    coordinator.emit("taskQueued");
  }
}

// ---------------------------------------------
// 8) Prosty serwer HTTP do obsługi API i index.html
// ---------------------------------------------
const httpServer = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  if (req.method === "GET" && parsedUrl.pathname === "/") {
    // Serwuj index.html
    fs.readFile(path.join(__dirname, "index.html"), (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end("Internal Server Error");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
  } else if (req.method === "GET" && parsedUrl.pathname === "/api/workers") {
    // Zwróć listę workerów
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        workersAll.map((w) => ({ idWorker: w.idWorker, enabled: w.enabled }))
      )
    );
  } else if (
    req.method === "POST" &&
    parsedUrl.pathname.startsWith("/api/worker/")
  ) {
    // Zmień status workera
    const id = parseInt(parsedUrl.pathname.split("/").pop(), 10);
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const { enabled } = JSON.parse(body);
        setWorkerEnabled(id, !!enabled);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end("Bad Request");
      }
    });
  } else if (req.method === "POST" && parsedUrl.pathname === "/api/run") {
    // Uruchom operację run
    startProcessingRun();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } else if (req.method === "POST" && parsedUrl.pathname === "/api/chunksize") {
    // Ustaw nowy chunkSize
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const { chunkSize } = JSON.parse(body);
        if (typeof chunkSize === "number" && chunkSize > 0) {
          global.CHUNK_SIZE = chunkSize;
          // Jeśli zmienna globalna nie działa, ustaw bezpośrednio:
          CHUNK_SIZE = chunkSize;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, chunkSize }));
        } else {
          res.writeHead(400);
          res.end("Bad chunkSize");
        }
      } catch (e) {
        res.writeHead(400);
        res.end("Bad Request");
      }
    });
  } else if (
    req.method === "POST" &&
    parsedUrl.pathname === "/api/start-worker"
  ) {
    // Uruchom nowego workera
    const child = spawn("node", ["./worker/worker.js"], {
      cwd: __dirname,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`HTTP: Serwer dostępny na http://localhost:${HTTP_PORT}/`);
});

server.listen(PORT, () => {
  console.log(`MASTER: Nasłuchuję na porcie ${PORT}…`);
  console.log("MASTER: Czekam na podłączenie co najmniej jednego workera…");
});
