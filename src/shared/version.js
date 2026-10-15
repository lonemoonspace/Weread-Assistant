const fs = require("fs");
const path = require("path");

function readVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8")
    );
    if (pkg && typeof pkg.version === "string" && pkg.version.trim() !== "") {
      return pkg.version.trim();
    }
  } catch (_) {}

  return "0.0.0";
}

const VERSION = readVersion();

module.exports = { VERSION };
