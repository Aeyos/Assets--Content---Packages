const fs = require('fs');
const path = require('path');
const { guessCategoryTags } = require('./auto-tag');

const CACHE_PATH = path.join(__dirname, 'asset-cache.json');

// Auto-tag applied to any asset the cache has never seen before, based on
// what kind of file it is - gives every new asset at least one useful tag
// without waiting on the user to curate it by hand.
const AUTO_TAG_BY_TYPE = { model: 'Model', image: 'Image', audio: 'Audio', other: 'Other' };

function loadCache() {
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf8');
    const data = JSON.parse(raw);
    return {
      tags: Array.isArray(data.tags) ? data.tags : [],
      assets: data.assets && typeof data.assets === 'object' ? data.assets : {},
    };
  } catch (e) {
    return { tags: [], assets: {} };
  }
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

function addTagToRegistry(cache, tag) {
  if (tag && !cache.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) {
    cache.tags.push(tag);
  }
}

// Applies persisted tags/hidden state onto freshly-scanned items (mutating
// them in place), auto-tagging anything the cache has never seen before, and
// drops cache entries for assets that no longer exist on disk. Returns the
// same cache object, updated, ready to be saved.
function reconcile(cache, items) {
  const seen = new Set();
  for (const item of items) {
    seen.add(item.key);
    const existing = cache.assets[item.key];
    if (existing) {
      item.tags = existing.tags || [];
      item.hidden = !!existing.hidden;
    } else {
      const autoTag = AUTO_TAG_BY_TYPE[item.assetType] || 'Other';
      const guessed = guessCategoryTags(item).filter((t) => t !== autoTag);
      const tags = [autoTag, ...guessed];
      for (const t of tags) addTagToRegistry(cache, t);
      item.tags = tags;
      item.hidden = false;
      cache.assets[item.key] = { tags: item.tags, hidden: item.hidden };
    }
  }
  for (const k of Object.keys(cache.assets)) {
    if (!seen.has(k)) delete cache.assets[k];
  }
  return cache;
}

function persistItem(cache, item) {
  cache.assets[item.key] = { tags: item.tags, hidden: item.hidden };
}

module.exports = { loadCache, saveCache, reconcile, persistItem, addTagToRegistry, CACHE_PATH };
