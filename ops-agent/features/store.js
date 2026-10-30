// Tiny JSON-file storage in ops-agent/data/ (git-ignored, survives deploys).

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const file = (name) => path.join(DATA_DIR, `${name}.json`);

exports.DATA_DIR = DATA_DIR;

exports.load = (name, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
};

// write-then-rename so a crash mid-write never leaves a half-written file
exports.save = (name, data) => {
  fs.writeFileSync(`${file(name)}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${file(name)}.tmp`, file(name));
};
