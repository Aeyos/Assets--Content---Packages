const fs = require('fs');
const path = require('path');

const MODEL_EXTS = new Set(['fbx', 'obj', 'gltf', 'glb', 'blend']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aiff']);

// Folder names that describe a FORMAT (or a generic wrapper) rather than the
// item/theme itself. These are skipped both when deriving the "pack" tag and
// when deriving an item's sub-path within its pack, so the same asset shipped
// as fbx/obj/gltf in sibling format folders - whether organized item-first
// (Ship/FBX, Ship/OBJ) or format-first (Assets/fbx, Assets/obj) - collapses
// into a single browsable entry instead of one per format.
const FORMAT_DIR_NAMES = new Set([
  'fbx', 'fbx_unity', 'fbx(unity)', 'obj', 'gltf', 'glb', 'blend', 'blends',
  'textures', 'texture', 'assets', 'samples',
]);

// Cover art / boilerplate that shouldn't show up as a browsable "asset".
const NOISE_NAME_RE = /(overview|preview|^sample$|readme|license|atlas)/i;

const MODEL_FORMAT_PRIORITY = ['glb', 'gltf', 'obj', 'fbx', 'blend'];
// Formats f3d can actually load (natively or via its assimp plugin) - blend
// has no loader there, so an item shipping only that has no path to a preview.
const RENDERABLE_PRIORITY = ['glb', 'gltf', 'obj', 'fbx'];
const IMAGE_THUMB_PRIORITY = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'];
const AUDIO_PRIMARY_PRIORITY = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aiff'];

const SKIP_DIR_NAMES = new Set(['.git', 'node_modules']);

// Sidecar/system files that are never themselves a browsable asset - Unity
// drops a .meta file next to every single asset it imports, mtl/bin are
// support files a model references (already resolved directly off disk by
// collectModelAssets() in server.js, independent of this list) rather than
// something meaningful on their own, and Windows scatters Thumbs.db/
// desktop.ini into any folder that's been opened in Explorer. Left
// unfiltered, a raw Unity or glTF export would flood the index with junk.
const EXCLUDED_FILENAMES = new Set(['thumbs.db', 'desktop.ini']);
const EXCLUDED_EXTS = new Set(['meta', 'mtl', 'bin']);

function extOf(filename) {
  return path.extname(filename).slice(1).toLowerCase();
}

function baseOf(filename, ext) {
  return ext ? filename.slice(0, -(ext.length + 1)) : filename;
}

function toUrlPath(p) {
  return p.split(path.sep).join('/');
}

// Recursively walks `dir`, calling onDir(dir, fileNames) for every directory
// that directly contains at least one file. `skipDirs` is a set of resolved
// absolute paths to exclude entirely (used to keep the app's own folder out
// of its own index).
function walk(dir, onDir, skipDirs) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  const files = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR_NAMES.has(e.name.toLowerCase())) continue;
      if (skipDirs.has(path.resolve(full))) continue;
      walk(full, onDir, skipDirs);
    } else if (e.isFile()) {
      const lower = e.name.toLowerCase();
      if (EXCLUDED_FILENAMES.has(lower)) continue;
      if (EXCLUDED_EXTS.has(extOf(e.name))) continue;
      files.push(e.name);
    }
  }
  if (files.length) onDir(dir, files);
}

function derivePack(relParts) {
  // relParts[0] is the top-level folder, relParts[1] is the theme.
  const rest = relParts.slice(2).filter((seg) => !FORMAT_DIR_NAMES.has(seg.toLowerCase()));
  return rest.length ? rest[0] : null;
}

// Path segments between the pack folder and the file's own directory, with
// format/wrapper folder names stripped out - this is what lets us merge an
// item across sibling format folders regardless of which pattern a given
// pack uses.
function deriveItemSubpath(relParts) {
  const rest = relParts.slice(2).filter((seg) => !FORMAT_DIR_NAMES.has(seg.toLowerCase()));
  return rest.slice(1); // drop the pack segment itself
}

// A stable identifier for a group of same-named files, used both to dedupe
// them into one browsable entry and as the persistent key for cached tags /
// hidden state (so it has to survive a rescan producing files in a different
// order, hence no numeric ids here).
function groupKey(assetType, r, base) {
  return [assetType, r.category, r.theme, r.pack, r.itemSubpath.join('/'), base.toLowerCase()].join('|');
}

function groupByExt(records, consumed, extSet, assetType, applyNoiseFilter) {
  const groups = new Map();
  for (const r of records) {
    if (!extSet.has(r.ext)) continue;
    const recKey = `${r.dir}::${r.file}`;
    if (consumed.has(recKey)) continue;
    if (assetType === 'image' && r.file.toLowerCase().endsWith('_thumb.png')) continue; // consumed by the model pass
    const base = baseOf(r.file, r.ext);
    if (applyNoiseFilter && NOISE_NAME_RE.test(base)) continue;
    const gkey = groupKey(assetType, r, base);
    if (!groups.has(gkey)) {
      groups.set(gkey, { key: gkey, category: r.category, theme: r.theme, pack: r.pack, base, exts: new Map() });
    }
    groups.get(gkey).exts.set(r.ext, r.dir);
    consumed.add(recKey);
  }
  return groups;
}

// Everything not already claimed by the model/image/audio passes - archives,
// tools, docs, anything else that lives in the library - still grouped by
// matching name so duplicate-but-differently-formatted leftovers collapse
// into one entry.
function groupRemaining(records, consumed) {
  const groups = new Map();
  for (const r of records) {
    const recKey = `${r.dir}::${r.file}`;
    if (consumed.has(recKey)) continue;
    const base = baseOf(r.file, r.ext);
    const gkey = groupKey('other', r, base);
    if (!groups.has(gkey)) {
      groups.set(gkey, { key: gkey, category: r.category, theme: r.theme, pack: r.pack, base, exts: new Map() });
    }
    groups.get(gkey).exts.set(r.ext, r.dir);
    consumed.add(recKey);
  }
  return groups;
}

function formatFilesOf(exts, base) {
  const formatFiles = {};
  for (const [ext, dir] of exts.entries()) {
    formatFiles[ext] = path.join(dir, ext ? `${base}.${ext}` : base);
  }
  return formatFiles;
}

function buildIndex(root) {
  const items = [];
  let idCounter = 0;
  const consumed = new Set(); // `${dir}::${file}` already claimed by an earlier group
  const selfDir = path.resolve(__dirname);

  // ---- pass 1: collect every file, recursively, from the library root ----
  const records = []; // { dir, relDir, category, theme, pack, itemSubpath, file, ext }
  walk(root, (dir, files) => {
    const relDir = path.relative(root, dir);
    const relParts = relDir ? relDir.split(path.sep) : [];
    const category = relParts.length > 0 ? relParts[0] : null;
    const theme = relParts.length > 1 ? relParts[1] : null;
    const pack = derivePack(relParts);
    const itemSubpath = deriveItemSubpath(relParts);
    for (const file of files) {
      records.push({ dir, relDir, category, theme, pack, itemSubpath, file, ext: extOf(file) });
    }
  }, new Set([selfDir]));

  const byDir = new Map(); // dir -> file list, used later for thumbnail lookup
  for (const r of records) {
    if (!byDir.has(r.dir)) byDir.set(r.dir, []);
    byDir.get(r.dir).push(r.file);
  }

  // ---- pass 2: group 3D model files into one entry per item ----
  const modelGroups = new Map();
  for (const r of records) {
    if (!MODEL_EXTS.has(r.ext)) continue;
    const base = baseOf(r.file, r.ext);
    if (NOISE_NAME_RE.test(base)) continue;
    const gkey = groupKey('model', r, base);
    if (!modelGroups.has(gkey)) {
      modelGroups.set(gkey, { key: gkey, category: r.category, theme: r.theme, pack: r.pack, base, exts: new Map() });
    }
    modelGroups.get(gkey).exts.set(r.ext, r.dir);
    consumed.add(`${r.dir}::${r.file}`);
  }

  for (const g of modelGroups.values()) {
    const exts = [...g.exts.keys()].sort();
    const primaryExt = MODEL_FORMAT_PRIORITY.find((e) => g.exts.has(e));
    const primaryDir = g.exts.get(primaryExt);

    let thumb = null;
    for (const dir of new Set(g.exts.values())) {
      const candidate = `${g.base}_thumb.png`;
      const match = (byDir.get(dir) || []).find((f) => f.toLowerCase() === candidate.toLowerCase());
      if (match) {
        thumb = toUrlPath(path.join(path.relative(root, dir), match));
        consumed.add(`${dir}::${match}`);
        break;
      }
    }

    const renderExt = RENDERABLE_PRIORITY.find((e) => g.exts.has(e));
    const renderPath = renderExt ? path.join(g.exts.get(renderExt), `${g.base}.${renderExt}`) : null;

    items.push({
      id: idCounter++,
      key: g.key,
      assetType: 'model',
      name: g.base.replace(/_/g, ' '),
      category: g.category,
      theme: g.theme,
      pack: g.pack,
      formats: exts,
      formatFiles: formatFilesOf(g.exts, g.base),
      thumb,
      filePath: path.join(primaryDir, `${g.base}.${primaryExt}`),
      dirPath: primaryDir,
      renderPath,
      renderable: !!renderPath,
    });
  }

  // ---- pass 3: images, grouped by matching name ----
  for (const g of groupByExt(records, consumed, IMAGE_EXTS, 'image', true).values()) {
    const exts = [...g.exts.keys()].sort();
    const thumbExt = IMAGE_THUMB_PRIORITY.find((e) => g.exts.has(e)) || exts[0];
    const thumbDir = g.exts.get(thumbExt);
    items.push({
      id: idCounter++,
      key: g.key,
      assetType: 'image',
      name: g.base.replace(/_/g, ' '),
      category: g.category,
      theme: g.theme,
      pack: g.pack,
      formats: exts,
      formatFiles: formatFilesOf(g.exts, g.base),
      thumb: toUrlPath(path.join(path.relative(root, thumbDir), `${g.base}.${thumbExt}`)),
      filePath: path.join(thumbDir, `${g.base}.${thumbExt}`),
      dirPath: thumbDir,
      renderPath: null,
      renderable: false,
    });
  }

  // ---- pass 4: audio, grouped by matching name ----
  for (const g of groupByExt(records, consumed, AUDIO_EXTS, 'audio', false).values()) {
    const exts = [...g.exts.keys()].sort();
    const primaryExt = AUDIO_PRIMARY_PRIORITY.find((e) => g.exts.has(e)) || exts[0];
    const primaryDir = g.exts.get(primaryExt);
    items.push({
      id: idCounter++,
      key: g.key,
      assetType: 'audio',
      name: g.base.replace(/_/g, ' '),
      category: g.category,
      theme: g.theme,
      pack: g.pack,
      formats: exts,
      formatFiles: formatFilesOf(g.exts, g.base),
      thumb: null,
      filePath: path.join(primaryDir, `${g.base}.${primaryExt}`),
      dirPath: primaryDir,
      renderPath: null,
      renderable: false,
    });
  }

  // ---- pass 5: everything else left over (archives, tools, docs...) ----
  for (const g of groupRemaining(records, consumed).values()) {
    const exts = [...g.exts.keys()].sort();
    const primaryExt = exts[0];
    const primaryDir = g.exts.get(primaryExt);
    items.push({
      id: idCounter++,
      key: g.key,
      assetType: 'other',
      name: g.base.replace(/_/g, ' '),
      category: g.category,
      theme: g.theme,
      pack: g.pack,
      formats: exts,
      formatFiles: formatFilesOf(g.exts, g.base),
      thumb: null,
      filePath: path.join(primaryDir, primaryExt ? `${g.base}.${primaryExt}` : g.base),
      dirPath: primaryDir,
      renderPath: null,
      renderable: false,
    });
  }

  // Root-relative URL path to the item's actual file, for anything (image
  // lightbox, audio player) that needs to serve the real asset over /files/
  // rather than a generated thumbnail.
  for (const it of items) {
    it.previewPath = toUrlPath(path.relative(root, it.filePath));
  }

  return items;
}

module.exports = { buildIndex };
