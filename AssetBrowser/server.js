const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, spawn } = require('child_process');
const { buildIndex } = require('./indexer');
const cacheStore = require('./cache');
const hashCacheStore = require('./hash-cache');

// No more requiring assets to live under a specific folder structure - the
// browser always scans its own parent folder, recursively, for whatever is there.
const ASSETS_ROOT = process.env.ASSETS_ROOT || path.resolve(__dirname, '..');
const PORT = process.env.PORT || 4747;
const F3D_BIN = process.env.F3D_BIN || 'f3d';
const PWSH_BIN = process.env.PWSH_BIN || 'powershell.exe';
const RENDER_TIMEOUT_MS = 30000;

// Preferred format to hand over when copying a file to the clipboard - fbx
// first since that's the most broadly importable format for game engines /
// DCC tools, falling back down to whatever else the item actually ships.
const COPY_FORMAT_PRIORITY = ['fbx', 'obj', 'gltf', 'glb', 'blend'];

const app = express();
app.use(express.json());

let assetCache = cacheStore.loadCache();
let fileHashCache = hashCacheStore.loadHashCache();
let cachedIndex = null;

function reindex() {
  const items = buildIndex(ASSETS_ROOT);
  cacheStore.reconcile(assetCache, items);
  cacheStore.saveCache(assetCache);
  cachedIndex = items;
  return cachedIndex;
}

function getIndex() {
  if (!cachedIndex) {
    console.log('Indexing', ASSETS_ROOT, '...');
    reindex();
    console.log('Indexed', cachedIndex.length, 'items.');
  }
  return cachedIndex;
}

function extOf(filename) {
  return path.extname(filename).slice(1).toLowerCase();
}

// Every path we hand to a child process or serve back to the client is
// derived from the index, but we still confirm it hasn't wandered outside
// the asset library (e.g. via a malformed relative reference) before touching it.
function withinRoot(candidate) {
  const rootResolved = path.resolve(ASSETS_ROOT);
  const resolved = path.resolve(candidate);
  if (!resolved.toLowerCase().startsWith(rootResolved.toLowerCase())) return null;
  return resolved;
}

function psQuote(str) {
  return `'${String(str).replace(/'/g, "''")}'`;
}

class ModelAssetError extends Error {}

app.get('/api/assets', (req, res) => {
  res.json(getIndex());
});

app.post('/api/rescan', (req, res) => {
  reindex();
  res.json({ count: cachedIndex.length });
});

app.get('/api/tags', (req, res) => {
  res.json([...assetCache.tags].sort((a, b) => a.localeCompare(b)));
});

app.post('/api/tags', (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: 'Tag name is required' });
  cacheStore.addTagToRegistry(assetCache, name);
  cacheStore.saveCache(assetCache);
  res.json([...assetCache.tags].sort((a, b) => a.localeCompare(b)));
});

app.post('/api/assets/:id/tags', (req, res) => {
  const id = Number(req.params.id);
  const item = getIndex().find((i) => i.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });

  const { tag, action } = req.body || {};
  const name = String(tag || '').trim();
  if (!name) return res.status(400).json({ error: 'Tag name is required' });

  if (action === 'remove') {
    item.tags = item.tags.filter((t) => t.toLowerCase() !== name.toLowerCase());
  } else {
    if (!item.tags.some((t) => t.toLowerCase() === name.toLowerCase())) item.tags.push(name);
    cacheStore.addTagToRegistry(assetCache, name);
  }
  cacheStore.persistItem(assetCache, item);
  cacheStore.saveCache(assetCache);
  res.json({ tags: item.tags, allTags: [...assetCache.tags].sort((a, b) => a.localeCompare(b)) });
});

app.post('/api/assets/:id/hidden', (req, res) => {
  const id = Number(req.params.id);
  const item = getIndex().find((i) => i.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });

  item.hidden = !!(req.body || {}).hidden;
  cacheStore.persistItem(assetCache, item);
  cacheStore.saveCache(assetCache);
  res.json({ hidden: item.hidden });
});

app.post('/api/reveal', (req, res) => {
  const { id } = req.body || {};
  const item = getIndex().find((i) => i.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });

  const resolved = withinRoot(item.filePath);
  if (!resolved) return res.status(400).json({ error: 'invalid path' });

  // explorer.exe often exits non-zero even on success, so we don't treat
  // its exit code as an error - fire and forget.
  exec(`explorer.exe /select,"${resolved}"`, () => {});
  res.json({ ok: true });
});

app.post('/api/copy-file', (req, res) => {
  const { id } = req.body || {};
  const item = getIndex().find((i) => i.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });

  const ext = [...COPY_FORMAT_PRIORITY, ...item.formats].find((e) => item.formatFiles[e]);
  const filePath = ext && item.formatFiles[ext];
  if (!filePath) return res.status(422).json({ error: `No file available for "${item.name}"` });

  const resolved = withinRoot(filePath);
  if (!resolved) return res.status(400).json({ error: 'invalid path' });
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: `Source file no longer exists: ${resolved}` });

  const proc = spawn(PWSH_BIN, ['-NoProfile', '-NonInteractive', '-Command', `Set-Clipboard -LiteralPath ${psQuote(resolved)}`]);
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  proc.on('error', (err) => {
    res.status(500).json({ error: `Could not launch ${PWSH_BIN}: ${err.message}` });
  });
  proc.on('close', (code) => {
    if (res.headersSent) return;
    if (code === 0) {
      res.json({ ok: true, name: path.basename(resolved), format: ext });
    } else {
      res.status(500).json({ error: stderr.trim() || `Clipboard copy exited with code ${code}` });
    }
  });
});

app.post('/api/generate-thumb', (req, res) => {
  const { id, force } = req.body || {};
  const item = getIndex().find((i) => i.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });
  if (item.thumb && !force) return res.json({ ok: true, thumb: item.thumb, alreadyExisted: true });
  if (!item.renderPath) {
    return res.status(422).json({
      error: `No renderable format for "${item.name}" - only ${item.formats.join('/')} available (need glb, gltf, obj, or fbx).`,
    });
  }

  const renderPath = withinRoot(item.renderPath);
  if (!renderPath) return res.status(400).json({ error: 'invalid path' });
  if (!fs.existsSync(renderPath)) {
    return res.status(404).json({ error: `Source file no longer exists: ${renderPath}` });
  }

  const dir = path.dirname(renderPath);
  const base = path.basename(renderPath, path.extname(renderPath));
  const outPath = path.join(dir, `${base}_thumb.png`);

  // f3d's native glTF/OBJ readers resolve the input through a URI parser that
  // rejects "[" and "]" - characters that show up constantly in asset-store
  // pack folder names (e.g. "MegaKit[Standard]"). Stage a bracket-free copy
  // of the model, plus whatever sibling files it references, in a temp dir
  // and point f3d at that; the output thumbnail still lands next to the real
  // source file, since --output isn't run through that same URI parsing.
  let stageDir;
  let stagedInput;
  try {
    ({ stageDir, stagedInput } = stageForRender(renderPath));
  } catch (e) {
    if (e instanceof ModelAssetError) return res.status(422).json({ error: e.message });
    throw e;
  }
  const cleanup = () => fs.rm(stageDir, { recursive: true, force: true }, () => {});

  const args = [
    stagedInput,
    `--output=${outPath}`,
    '--resolution=512,512',
    '--load-plugins=assimp',
    '--no-background',
  ];
  const proc = spawn(F3D_BIN, args, { timeout: RENDER_TIMEOUT_MS });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d) => { stdout += d; });
  proc.stderr.on('data', (d) => { stderr += d; });

  proc.on('error', (err) => {
    cleanup();
    res.status(500).json({ error: `Could not launch f3d (${F3D_BIN}): ${err.message}` });
  });

  proc.on('close', (code) => {
    cleanup();
    if (res.headersSent) return;
    if (code === 0 && fs.existsSync(outPath)) {
      const thumb = path.relative(ASSETS_ROOT, outPath).split(path.sep).join('/');
      item.thumb = thumb; // patch the cached index so it shows up without a rescan
      res.json({ ok: true, thumb });
    } else {
      const message = (stdout + stderr).trim() || `f3d exited with code ${code}`;
      res.status(500).json({ error: message });
    }
  });
});

// Hashes one item's file (reusing the on-disk cache when the file hasn't
// changed since it was last hashed), for the client-side duplicate finder to
// call one item at a time - same "one at a time, with progress" shape as
// /api/generate-thumb so it can drive the same kind of Stop-able bulk button.
app.post('/api/hash-item', async (req, res) => {
  const { id } = req.body || {};
  const item = getIndex().find((i) => i.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });

  const resolved = withinRoot(item.filePath);
  if (!resolved) return res.status(400).json({ error: 'invalid path' });
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: `Source file no longer exists: ${resolved}` });

  try {
    const { hash, size, mtimeMs, cached } = await hashCacheStore.hashWithCache(fileHashCache, ASSETS_ROOT, resolved);
    if (!cached) hashCacheStore.saveHashCache(fileHashCache);
    res.json({ id: item.id, hash, size, mtimeMs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Resolve the exact sibling files (materials, buffers, textures) a model
// actually references, so the in-browser viewer can stage a self-contained
// copy in its virtual filesystem without pulling in a whole shared pack folder.
function collectModelAssets(mainPath) {
  const mainDir = path.dirname(mainPath);
  const ext = extOf(mainPath);
  const refs = new Set([mainPath]);
  const missing = new Set(); // referenced by the model but not found on disk - pack is incomplete

  // Returns the resolved absolute path for an in-root reference, or null to
  // silently ignore it (data: URI, absolute URL, or it resolves outside the
  // asset library). Existence is NOT checked here - the caller records it as
  // either present or missing so the viewer can substitute a placeholder for
  // the latter instead of the whole scene load hard-failing.
  function resolveRef(baseDir, uri) {
    if (!uri || /^[a-z]+:/i.test(uri)) return null;
    let decoded = uri;
    try { decoded = decodeURIComponent(uri); } catch { /* keep raw */ }
    return withinRoot(path.resolve(baseDir, decoded));
  }

  if (ext === 'obj') {
    const objText = fs.readFileSync(mainPath, 'utf8');
    const mtlNames = [...objText.matchAll(/^\s*mtllib\s+(.+?)\s*$/gim)].map((m) => m[1]);
    for (const mtlName of mtlNames) {
      const mtlAbs = resolveRef(mainDir, mtlName);
      if (!mtlAbs) continue;
      if (!fs.existsSync(mtlAbs)) { missing.add(mtlAbs); continue; }
      refs.add(mtlAbs);
      const mtlText = fs.readFileSync(mtlAbs, 'utf8');
      const texMatches = [...mtlText.matchAll(/^\s*(map_Kd|map_Ka|map_Ks|map_Ns|map_d|map_bump|bump|disp|decal|refl)\s+(.+?)\s*$/gim)];
      for (const m of texMatches) {
        const tokens = m[2].trim().split(/\s+/);
        const texAbs = resolveRef(path.dirname(mtlAbs), tokens[tokens.length - 1]);
        if (!texAbs) continue;
        (fs.existsSync(texAbs) ? refs : missing).add(texAbs);
      }
    }
  } else if (ext === 'gltf') {
    let json;
    try { json = JSON.parse(fs.readFileSync(mainPath, 'utf8')); } catch { json = {}; }
    // A missing buffer means the mesh geometry itself is unavailable - no
    // reasonable placeholder for that, so fail loudly instead of handing f3d
    // a scene it can never actually load.
    for (const buf of json.buffers || []) {
      const abs = resolveRef(mainDir, buf.uri);
      if (!abs) continue;
      if (!fs.existsSync(abs)) {
        throw new ModelAssetError(`Missing required data file "${path.basename(abs)}" - this asset appears incomplete.`);
      }
      refs.add(abs);
    }
    // A missing image is just a texture - substitute a placeholder rather
    // than failing the whole scene over one blank material slot.
    for (const img of json.images || []) {
      const abs = resolveRef(mainDir, img.uri);
      if (!abs) continue;
      (fs.existsSync(abs) ? refs : missing).add(abs);
    }
  }
  // glb is self-contained; fbx/blend sibling textures aren't resolved (format
  // is opaque to us here) so those may render untextured - still better than nothing.

  const absList = [...refs, ...missing];
  let commonRoot = mainDir;
  if (absList.length > 1) {
    const partsList = absList.map((p) => path.dirname(p).split(path.sep));
    let common = partsList[0];
    for (const parts of partsList.slice(1)) {
      let i = 0;
      while (i < common.length && i < parts.length && common[i].toLowerCase() === parts[i].toLowerCase()) i++;
      common = common.slice(0, i);
    }
    commonRoot = common.join(path.sep);
  }

  const toUrlPath = (p) => p.split(path.sep).join('/');
  return {
    mainFile: toUrlPath(path.relative(commonRoot, mainPath)),
    files: [...refs].map((abs) => ({
      relPath: toUrlPath(path.relative(commonRoot, abs)),
      url: '/files/' + toUrlPath(path.relative(ASSETS_ROOT, abs)),
      abs,
    })),
    missing: [...missing].map((abs) => ({
      relPath: toUrlPath(path.relative(commonRoot, abs)),
      name: path.basename(abs),
    })),
  };
}

// Copies a model into a fresh temp directory - using collectModelAssets' own
// closure of referenced sibling files for gltf/obj, so relative buffer/image
// URIs still resolve - so f3d never sees the source asset library's path at
// all. See the comment at the generate-thumb route for why that's needed.
function stageForRender(renderPath) {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assetbrowser-render-'));
  const ext = extOf(renderPath);

  if (ext === 'gltf' || ext === 'obj') {
    const { mainFile, files } = collectModelAssets(renderPath);
    for (const f of files) {
      const dest = path.join(stageDir, ...f.relPath.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f.abs, dest);
    }
    return { stageDir, stagedInput: path.join(stageDir, ...mainFile.split('/')) };
  }

  const dest = path.join(stageDir, path.basename(renderPath));
  fs.copyFileSync(renderPath, dest);
  return { stageDir, stagedInput: dest };
}

app.get('/api/model-assets/:id', (req, res) => {
  const id = Number(req.params.id);
  const item = getIndex().find((i) => i.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });
  if (!item.renderPath) return res.status(422).json({ error: `No renderable format for "${item.name}"` });

  const renderPath = withinRoot(item.renderPath);
  if (!renderPath) return res.status(400).json({ error: 'invalid path' });
  if (!fs.existsSync(renderPath)) {
    return res.status(404).json({ error: `Source file no longer exists: ${renderPath}` });
  }

  try {
    res.json(collectModelAssets(renderPath));
  } catch (e) {
    if (e instanceof ModelAssetError) return res.status(422).json({ error: e.message });
    throw e;
  }
});

// Serve the asset files themselves (thumbnails, sprite images) read-only.
app.use('/files', express.static(ASSETS_ROOT, { dotfiles: 'ignore' }));

// Serve the f3d WebAssembly viewer build so the browser can load it directly.
app.use('/vendor/f3d', express.static(path.join(__dirname, 'node_modules', 'f3d', 'dist')));

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  getIndex(); // warm the cache at startup
  console.log(`Asset browser running at http://localhost:${PORT}`);
});
