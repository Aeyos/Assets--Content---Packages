const fs = require('fs');
const path = require('path');

const CATEGORIES = ['3d', '2d', 'UI', 'Lost and found'];

const MODEL_EXTS = new Set(['fbx', 'obj', 'gltf', 'glb', 'blend']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

// Folder names that describe a FORMAT (or a generic wrapper) rather than the
// item/theme itself. These are skipped both when deriving the "pack" tag and
// when deriving an item's sub-path within its pack, so the same model shipped
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

function extOf(filename) {
  return path.extname(filename).slice(1).toLowerCase();
}

function baseOf(filename, ext) {
  return ext ? filename.slice(0, -(ext.length + 1)) : filename;
}

function toUrlPath(p) {
  return p.split(path.sep).join('/');
}

function walk(dir, onDir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  const files = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, onDir);
    } else if (e.isFile()) {
      files.push(e.name);
    }
  }
  if (files.length) onDir(dir, files);
}

function derivePack(relParts) {
  // relParts[0] is the category, relParts[1] is the theme.
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

function buildIndex(root) {
  const items = [];
  let idCounter = 0;
  const consumed = new Set(); // `${dir}::${file}` already claimed by a model group
  const key = (dir, file) => `${dir}::${file}`;

  // ---- pass 1: collect every file with its category/theme/pack context ----
  const records = []; // { dir, relDir, relParts, category, theme, pack, itemSubpath, file, ext }
  for (const cat of CATEGORIES) {
    const catDir = path.join(root, cat);
    if (!fs.existsSync(catDir)) continue;
    walk(catDir, (dir, files) => {
      const relDir = path.relative(root, dir);
      const relParts = relDir.split(path.sep);
      const theme = relParts.length > 1 ? relParts[1] : null;
      const pack = derivePack(relParts);
      const itemSubpath = deriveItemSubpath(relParts);
      for (const file of files) {
        records.push({ dir, relDir, category: cat, theme, pack, itemSubpath, file, ext: extOf(file) });
      }
    });
  }

  const byDir = new Map(); // dir -> file list, used later for thumbnail lookup
  for (const r of records) {
    if (!byDir.has(r.dir)) byDir.set(r.dir, []);
    byDir.get(r.dir).push(r.file);
  }

  // ---- pass 2: group 3D model files into one entry per item ----
  const groups = new Map();
  for (const r of records) {
    if (!MODEL_EXTS.has(r.ext)) continue;
    const base = baseOf(r.file, r.ext);
    if (NOISE_NAME_RE.test(base)) continue;
    const gkey = [r.category, r.theme, r.pack, r.itemSubpath.join('/'), base].join('|');
    if (!groups.has(gkey)) {
      groups.set(gkey, {
        category: r.category, theme: r.theme, pack: r.pack, base,
        exts: new Map(), // ext -> dir
      });
    }
    groups.get(gkey).exts.set(r.ext, r.dir);
    consumed.add(key(r.dir, r.file));
  }

  // Formats f3d can actually load (natively or via its assimp plugin) - blend
  // has no loader there, so an item shipping only that has no path to a preview.
  const RENDERABLE_PRIORITY = ['glb', 'gltf', 'obj', 'fbx'];

  for (const g of groups.values()) {
    const exts = [...g.exts.keys()].sort();
    const primaryExt = MODEL_FORMAT_PRIORITY.find((e) => g.exts.has(e));
    const primaryDir = g.exts.get(primaryExt);

    let thumb = null;
    for (const dir of new Set(g.exts.values())) {
      const candidate = `${g.base}_thumb.png`;
      const match = (byDir.get(dir) || []).find((f) => f.toLowerCase() === candidate.toLowerCase());
      if (match) {
        thumb = toUrlPath(path.join(path.relative(root, dir), match));
        consumed.add(key(dir, match));
        break;
      }
    }

    const renderExt = RENDERABLE_PRIORITY.find((e) => g.exts.has(e));
    const renderPath = renderExt ? path.join(g.exts.get(renderExt), `${g.base}.${renderExt}`) : null;

    const formatFiles = {};
    for (const [ext, dir] of g.exts.entries()) {
      formatFiles[ext] = path.join(dir, `${g.base}.${ext}`);
    }

    items.push({
      id: idCounter++,
      name: g.base.replace(/_/g, ' '),
      category: g.category,
      theme: g.theme,
      pack: g.pack,
      formats: exts,
      formatFiles,
      thumb,
      filePath: path.join(primaryDir, `${g.base}.${primaryExt}`),
      dirPath: primaryDir,
      renderPath,
      renderable: !!renderPath,
    });
  }

  // ---- pass 3: leftover images become their own entries ----
  for (const r of records) {
    if (consumed.has(key(r.dir, r.file))) continue;
    if (!IMAGE_EXTS.has(r.ext)) continue;
    if (r.file.toLowerCase().endsWith('_thumb.png')) continue;
    const base = baseOf(r.file, r.ext);
    if (NOISE_NAME_RE.test(base)) continue;
    const dirNameLower = path.basename(r.dir).toLowerCase();
    const isTextureDump = /^textures?$/.test(dirNameLower);
    if ((r.category === '3d' || r.category === 'UI') && isTextureDump) continue;

    items.push({
      id: idCounter++,
      name: base.replace(/_/g, ' '),
      category: r.category,
      theme: r.theme,
      pack: r.pack,
      formats: [r.ext],
      formatFiles: { [r.ext]: path.join(r.dir, r.file) },
      thumb: toUrlPath(path.join(r.relDir, r.file)),
      filePath: path.join(r.dir, r.file),
      dirPath: r.dir,
      renderPath: null,
      renderable: false,
    });
    consumed.add(key(r.dir, r.file));
  }

  // ---- pass 4: Lost and found also surfaces plain files (archives, tools) ----
  for (const r of records) {
    if (r.category !== 'Lost and found') continue;
    if (consumed.has(key(r.dir, r.file))) continue;
    const base = baseOf(r.file, r.ext);
    items.push({
      id: idCounter++,
      name: base.replace(/_/g, ' '),
      category: r.category,
      theme: null,
      pack: null,
      formats: [r.ext],
      formatFiles: { [r.ext]: path.join(r.dir, r.file) },
      thumb: null,
      filePath: path.join(r.dir, r.file),
      dirPath: r.dir,
      renderPath: null,
      renderable: false,
    });
    consumed.add(key(r.dir, r.file));
  }

  return items;
}

module.exports = { buildIndex, CATEGORIES };
