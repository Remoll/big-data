const factualBussyWorkers = [];

// Kolejka zadań (każdy task = { id, data: "<ciąg cyfr>" })
const workersAll = []; // lista WSZYSTKICH workerów (do odnajdywania po socket)

exports.factualBussyWorkers = factualBussyWorkers;
exports.workersAll = workersAll;