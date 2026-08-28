const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HASH_CACHE_PATH = path.join(__dirname, 'hash-cache.json');

// Content hashes keyed by path relative to ASSETS_ROOT (POSIX-style), so the
// cache survives the library being pointed at from a different ASSETS_ROOT.
// Each entry also records the size/mtime the hash was computed against, so
// an unchanged file's hash is served from cache instead of re-reading it.
function loadHashCache() {
  try {
    const raw = fs.readFileSync(HASH_CACHE_PATH, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch (e) {
    return {};
  }
}

function saveHashCache(cache) {
  fs.writeFileSync(HASH_CACHE_PATH, JSON.stringify(cache, null, 2));
}

function hashFile(absPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    fs.createReadStream(absPath)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

// Resolves the sha1 of `absPath`, reusing `cache` when the file's size and
// mtime match what's recorded there, and re-hashing (updating the cache
// entry) otherwise. `cached` tells the caller whether anything changed, so
// it only needs to persist the cache back to disk when it did.
async function hashWithCache(cache, root, absPath) {
  const key = path.relative(root, absPath).split(path.sep).join('/');
  const stat = fs.statSync(absPath);
  const existing = cache[key];
  if (existing && existing.size === stat.size && existing.mtimeMs === stat.mtimeMs) {
    return { hash: existing.hash, size: stat.size, mtimeMs: stat.mtimeMs, cached: true };
  }
  const hash = await hashFile(absPath);
  cache[key] = { size: stat.size, mtimeMs: stat.mtimeMs, hash };
  return { hash, size: stat.size, mtimeMs: stat.mtimeMs, cached: false };
}

module.exports = { loadHashCache, saveHashCache, hashWithCache, HASH_CACHE_PATH };
