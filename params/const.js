// ------ PARAMETRY ------
const path = require("path");

const PORT = 4000; // port, na którym master nasłuchuje
const SOURCE_FILE = path.join(__dirname, "../DO_NOT_OPEN_!!!.txt");
const HTTP_PORT = 8080;

exports.PORT = PORT;
exports.SOURCE_FILE = SOURCE_FILE;
exports.HTTP_PORT = HTTP_PORT;