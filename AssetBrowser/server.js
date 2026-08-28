const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, spawn } = require('child_process');
const { buildIndex } = require('./indexer');
const cacheStore = require('./cache');
const hashCacheStore = require('./hash-cache');
const configStore = require('./config');

// No more requiring assets to live under a specific folder structure - the
// browser always scans its own parent folder, recursively, for whatever is there.
const ASSETS_ROOT = process.env.ASSETS_ROOT || path.resolve(__dirname, '..');
const PORT = process.env.PORT || 4747;
const F3D_BIN = process.env.F3D_BIN || 'f3d';
const PWSH_BIN = process.env.PWSH_BIN || 'powershell.exe';
const BLENDER_BIN = process.env.BLENDER_BIN || 'blender';
const RENDER_TIMEOUT_MS = 30000;
const BLEND_CONVERT_TIMEOUT_MS = 90000;

// Preferred format to hand over when copying a file to the clipboard - fbx
// first since that's the most broadly importable format for game engines /
// DCC tools, falling back down to whatever else the item actually ships.
const COPY_FORMAT_PRIORITY = ['fbx', 'obj', 'gltf', 'glb', 'blend'];

const app = express();
app.use(express.json());

let assetCache = cacheStore.loadCache();
let fileHashCache = hashCacheStore.loadHashCache();
let appConfig = configStore.loadConfig();
let cachedIndex = null;

function reindex() {
  const items = buildIndex(ASSETS_ROOT, {
    blacklistExtensions: appConfig.blacklistExtensions,
    blacklistFolders: appConfig.blacklistFolders,
  });
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

// Sends files to the Windows Recycle Bin (rather than a hard delete) so a
// mis-flagged "duplicate" can still be recovered by hand.
function recycleFiles(absPaths) {
  return new Promise((resolve, reject) => {
    if (!absPaths.length) return resolve();
    const list = absPaths.map(psQuote).join(',');
    const script = `Add-Type -AssemblyName Microsoft.VisualBasic; foreach ($p in @(${list})) { if (Test-Path -LiteralPath $p) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } }`;
    const proc = spawn(PWSH_BIN, ['-NoProfile', '-NonInteractive', '-Command', script]);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => reject(new Error(`Could not launch ${PWSH_BIN}: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Recycle exited with code ${code}`));
    });
  });
}

class ModelAssetError extends Error {}

// f3d has no loader for .blend, so previewing one means exporting it to FBX
// via Blender's own CLI first. The export is cached next to the source
// (<base>.blendpreview.fbx, filtered out of the index by indexer.js) and
// reused as long as it's newer than the .blend, so repeat preview/thumbnail
// requests don't re-launch Blender every time.
function ensureFbxFromBlend(blendPath) {
  const dir = path.dirname(blendPath);
  const base = path.basename(blendPath, path.extname(blendPath));
  const outPath = path.join(dir, `${base}.blendpreview.fbx`);

  const blendMtimeMs = fs.statSync(blendPath).mtimeMs;
  if (fs.existsSync(outPath) && fs.statSync(outPath).mtimeMs >= blendMtimeMs) {
    return Promise.resolve(outPath);
  }

  return new Promise((resolve, reject) => {
    const pyExpr = `import bpy; bpy.ops.export_scene.fbx(filepath=${JSON.stringify(outPath)})`;
    const proc = spawn(BLENDER_BIN, ['--background', blendPath, '--python-expr', pyExpr], { timeout: BLEND_CONVERT_TIMEOUT_MS });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => reject(new Error(`Could not launch Blender (${BLENDER_BIN}): ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outPath)) resolve(outPath);
      else reject(new Error((stdout + stderr).trim() || `Blender exited with code ${code}`));
    });
  });
}

app.get('/api/assets', (req, res) => {
  res.json(getIndex());
});

app.post('/api/rescan', (req, res) => {
  reindex();
  res.json({ count: cachedIndex.length });
});

app.get('/api/config', (req, res) => {
  res.json(appConfig);
});

// Blacklist edits only touch the saved config - they take effect on the next
// /api/rescan rather than triggering an immediate reindex.
app.post('/api/config/extensions', (req, res) => {
  const { action, value } = req.body || {};
  const ext = configStore.normalizeExt(value);
  if (!ext) return res.status(400).json({ error: 'Extension is required' });

  if (action === 'remove') {
    appConfig.blacklistExtensions = appConfig.blacklistExtensions.filter((e) => e !== ext);
  } else if (!appConfig.blacklistExtensions.includes(ext)) {
    appConfig.blacklistExtensions.push(ext);
  }
  configStore.saveConfig(appConfig);
  res.json(appConfig);
});

app.post('/api/config/folders', (req, res) => {
  const { action, value } = req.body || {};
  const folder = configStore.normalizeFolder(value);
  if (!folder) return res.status(400).json({ error: 'Folder path is required' });

  if (action === 'remove') {
    appConfig.blacklistFolders = appConfig.blacklistFolders.filter((f) => f !== folder);
  } else if (!appConfig.blacklistFolders.some((f) => f.toLowerCase() === folder.toLowerCase())) {
    appConfig.blacklistFolders.push(folder);
  }
  configStore.saveConfig(appConfig);
  res.json(appConfig);
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

// Deletes an item's file(s) - every format it ships (fbx+obj siblings count as
// one item) plus its generated thumbnail - recycling rather than unlinking,
// and drops the item from the in-memory index and both on-disk caches so it
// doesn't reappear until the next full rescan.
app.delete('/api/assets/:id', async (req, res) => {
  const id = Number(req.params.id);
  const idx = getIndex();
  const itemIdx = idx.findIndex((i) => i.id === id);
  if (itemIdx === -1) return res.status(404).json({ error: 'not found' });
  const item = idx[itemIdx];

  const targets = new Set(Object.values(item.formatFiles));
  if (item.thumb) targets.add(path.join(ASSETS_ROOT, ...item.thumb.split('/')));

  const resolvedPaths = [];
  for (const filePath of targets) {
    const resolved = withinRoot(filePath);
    if (!resolved) return res.status(400).json({ error: 'invalid path' });
    resolvedPaths.push(resolved);
  }

  try {
    await recycleFiles(resolvedPaths);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  for (const resolved of resolvedPaths) {
    const relKey = path.relative(ASSETS_ROOT, resolved).split(path.sep).join('/');
    delete fileHashCache[relKey];
  }
  hashCacheStore.saveHashCache(fileHashCache);
  delete assetCache.assets[item.key];
  cacheStore.saveCache(assetCache);
  idx.splice(itemIdx, 1);

  res.json({ ok: true });
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

app.post('/api/generate-thumb', async (req, res) => {
  const { id, force } = req.body || {};
  const item = getIndex().find((i) => i.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });
  if (item.thumb && !force) return res.json({ ok: true, thumb: item.thumb, alreadyExisted: true });
  if (!item.renderPath) {
    return res.status(422).json({
      error: `No renderable format for "${item.name}" - only ${item.formats.join('/')} available (need glb, gltf, obj, fbx, or blend).`,
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

  let sourcePath = renderPath;
  if (extOf(renderPath) === 'blend') {
    try {
      sourcePath = await ensureFbxFromBlend(renderPath);
    } catch (e) {
      return res.status(500).json({ error: `Blender conversion failed: ${e.message}` });
    }
  }

  // f3d's native glTF/OBJ readers resolve the input through a URI parser that
  // rejects "[" and "]" - characters that show up constantly in asset-store
  // pack folder names (e.g. "MegaKit[Standard]"). Stage a bracket-free copy
  // of the model, plus whatever sibling files it references, in a temp dir
  // and point f3d at that; the output thumbnail still lands next to the real
  // source file, since --output isn't run through that same URI parsing.
  let stageDir;
  let stagedInput;
  try {
    ({ stageDir, stagedInput } = stageForRender(sourcePath));
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

app.get('/api/model-assets/:id', async (req, res) => {
  const id = Number(req.params.id);
  const item = getIndex().find((i) => i.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });
  if (!item.renderPath) return res.status(422).json({ error: `No renderable format for "${item.name}"` });

  const renderPath = withinRoot(item.renderPath);
  if (!renderPath) return res.status(400).json({ error: 'invalid path' });
  if (!fs.existsSync(renderPath)) {
    return res.status(404).json({ error: `Source file no longer exists: ${renderPath}` });
  }

  let sourcePath = renderPath;
  if (extOf(renderPath) === 'blend') {
    try {
      sourcePath = await ensureFbxFromBlend(renderPath);
    } catch (e) {
      return res.status(500).json({ error: `Blender conversion failed: ${e.message}` });
    }
  }

  try {
    res.json(collectModelAssets(sourcePath));
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
