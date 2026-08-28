const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const data = JSON.parse(raw);
    return {
      blacklistExtensions: Array.isArray(data.blacklistExtensions) ? data.blacklistExtensions : [],
      blacklistFolders: Array.isArray(data.blacklistFolders) ? data.blacklistFolders : [],
    };
  } catch (e) {
    return { blacklistExtensions: [], blacklistFolders: [] };
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function normalizeExt(ext) {
  return String(ext || '').trim().replace(/^\./, '').toLowerCase();
}

// Folder blacklist entries are relative paths from the library root, e.g.
// "Packs/Old Stuff" - normalized to forward slashes with no leading/trailing
// slash so they compare consistently regardless of how the user typed them.
function normalizeFolder(folder) {
  return String(folder || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

module.exports = { loadConfig, saveConfig, normalizeExt, normalizeFolder, CONFIG_PATH };
