// Best-effort category tags guessed from an asset's folder/pack/file name.
// These are a starting point for manual curation, not a guarantee - a folder
// or filename containing one of these words gets the matching tag; anything
// that doesn't match any keyword is left for the user to tag by hand.
const KEYWORD_TAGS = {
  Character: [
    'character', 'characters', 'char', 'chars', 'npc', 'npcs', 'player', 'players',
    'hero', 'heroes', 'enemy', 'enemies', 'creature', 'creatures', 'monster', 'monsters',
    'humanoid', 'humanoids', 'avatar', 'avatars', 'skeleton', 'skeletons', 'zombie', 'zombies',
    'knight', 'knights', 'warrior', 'warriors', 'wizard', 'wizards', 'mage', 'mages',
    'elf', 'elves', 'orc', 'orcs', 'goblin', 'goblins', 'dragon', 'dragons',
    'animal', 'animals', 'beast', 'beasts', 'rig', 'rigged', 'costume', 'costumes',
    'clothing', 'armor', 'armour', 'outfit', 'outfits', 'pony', 'ponies',
  ],
  Prop: [
    'prop', 'props', 'item', 'items', 'weapon', 'weapons', 'sword', 'swords', 'gun', 'guns',
    'firearm', 'firearms', 'furniture', 'chair', 'chairs', 'table', 'tables', 'crate', 'crates',
    'barrel', 'barrels', 'chest', 'chests', 'tool', 'tools', 'potion', 'potions', 'coin', 'coins',
    'key', 'keys', 'shield', 'shields', 'bag', 'bags', 'container', 'containers', 'decor',
    'decoration', 'decorations', 'gadget', 'gadgets', 'equipment', 'vehicle', 'vehicles',
    'car', 'cars', 'ship', 'ships', 'food', 'foods',
  ],
  Environment: [
    'environment', 'environments', 'env', 'terrain', 'terrains', 'landscape', 'landscapes',
    'level', 'levels', 'scene', 'scenes', 'dungeon', 'dungeons', 'building', 'buildings',
    'architecture', 'city', 'cities', 'town', 'towns', 'village', 'villages', 'forest', 'forests',
    'nature', 'vegetation', 'tree', 'trees', 'rock', 'rocks', 'mountain', 'mountains',
    'cave', 'caves', 'sky', 'skybox', 'skyboxes', 'ground', 'floor', 'floors', 'wall', 'walls',
    'road', 'roads', 'street', 'streets', 'map', 'maps', 'world', 'worlds', 'biome', 'biomes',
    'island', 'islands', 'castle', 'castles', 'ruins', 'house', 'houses', 'interior', 'interiors',
    'exterior', 'exteriors',
  ],
};

function normalizeWords(str) {
  return String(str || '').toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
}

// Returns tags guessed from an item's path context and name - a "3D" tag for
// every 3D-model asset (unambiguous, not a guess), plus Character/Prop/
// Environment when a folder or file name matches one of the keyword lists
// above. An asset can match more than one, or none at all.
function guessCategoryTags(item) {
  const haystack = new Set(normalizeWords([item.category, item.theme, item.pack, item.name].filter(Boolean).join(' ')));
  const tags = [];
  if (item.assetType === 'model') tags.push('3D');
  for (const [tag, keywords] of Object.entries(KEYWORD_TAGS)) {
    if (keywords.some((k) => haystack.has(k))) tags.push(tag);
  }
  return tags;
}

module.exports = { guessCategoryTags, KEYWORD_TAGS };
