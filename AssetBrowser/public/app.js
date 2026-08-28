(() => {
  const PAGE_SIZE = 150;
  const PLACEHOLDER_ICON = {
    model: '🧊',
    image: '🖼️',
    audio: '🎵',
    other: '🗂️',
  };

  let allItems = [];
  let filtered = [];
  let shownCount = 0;
  let knownTags = [];

  const state = {
    search: '',
    category: new Set(),
    theme: new Set(),
    pack: new Set(),
    tags: new Set(),
    showHidden: false,
  };

  const el = {
    search: document.getElementById('search'),
    rescan: document.getElementById('rescan'),
    showHidden: document.getElementById('show-hidden'),
    grid: document.getElementById('grid'),
    status: document.getElementById('status'),
    regenAll: document.getElementById('regen-all'),
    loadMore: document.getElementById('load-more'),
    clearFilters: document.getElementById('clear-filters'),
    pillsCategory: document.getElementById('pills-category'),
    pillsTheme: document.getElementById('pills-theme'),
    pillsPack: document.getElementById('pills-pack'),
    pillsTags: document.getElementById('pills-tags'),
    knownTagsList: document.getElementById('known-tags'),
  };

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function showToast(msg) {
    let t = document.querySelector('.toast');
    if (!t) {
      t = document.createElement('div');
      t.className = 'toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._hideTimer);
    t._hideTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  function buildPillGroup(container, values, selectedSet, onChange) {
    container.innerHTML = '';
    const sorted = [...values.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [value, count] of sorted) {
      const pill = document.createElement('button');
      pill.className = 'pill' + (selectedSet.has(value) ? ' active' : '');
      pill.type = 'button';
      pill.innerHTML = `${escapeHtml(value)}<span class="count">${count}</span>`;
      pill.addEventListener('click', () => {
        if (selectedSet.has(value)) selectedSet.delete(value);
        else selectedSet.add(value);
        onChange();
      });
      container.appendChild(pill);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function countBy(items, keyFn) {
    const m = new Map();
    for (const it of items) {
      const k = keyFn(it);
      if (!k) continue;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  }

  function countByTags(items) {
    const m = new Map();
    for (const it of items) {
      for (const t of it.tags || []) m.set(t, (m.get(t) || 0) + 1);
    }
    return m;
  }

  function rebuildFilterPills() {
    // Category/theme/pack/tags pill lists reflect what's reachable given the
    // OTHER active filters (so picking a theme narrows the pack list, etc).
    const byCategory = applyFilters(allItems, { skip: 'category' });
    const byTheme = applyFilters(allItems, { skip: 'theme' });
    const byPack = applyFilters(allItems, { skip: 'pack' });
    const byTags = applyFilters(allItems, { skip: 'tags' });

    buildPillGroup(el.pillsCategory, countBy(byCategory, (i) => i.category), state.category, onFiltersChanged);
    buildPillGroup(el.pillsTheme, countBy(byTheme, (i) => i.theme), state.theme, onFiltersChanged);
    buildPillGroup(el.pillsPack, countBy(byPack, (i) => i.pack), state.pack, onFiltersChanged);
    buildPillGroup(el.pillsTags, countByTags(byTags), state.tags, onFiltersChanged);
  }

  function applyFilters(items, opts = {}) {
    const skip = opts.skip;
    const q = state.search.trim().toLowerCase();
    return items.filter((it) => {
      if (!state.showHidden && it.hidden) return false;
      if (skip !== 'category' && state.category.size && !state.category.has(it.category)) return false;
      if (skip !== 'theme' && state.theme.size && !state.theme.has(it.theme)) return false;
      if (skip !== 'pack' && state.pack.size && !state.pack.has(it.pack)) return false;
      if (skip !== 'tags' && state.tags.size) {
        const itemTags = new Set(it.tags || []);
        for (const t of state.tags) if (!itemTags.has(t)) return false;
      }
      if (q) {
        const hay = `${it.name} ${it.pack || ''} ${it.theme || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function removeCardFromView(item) {
    const idx = filtered.indexOf(item);
    if (idx !== -1) {
      filtered.splice(idx, 1);
      if (idx < shownCount) shownCount--;
    }
    el.grid.querySelector(`.card[data-id="${item.id}"]`)?.remove();
    el.status.textContent = `${filtered.length.toLocaleString()} of ${allItems.length.toLocaleString()} assets`;
    el.loadMore.hidden = shownCount >= filtered.length;
  }

  function refreshKnownTagsList() {
    el.knownTagsList.innerHTML = '';
    for (const t of knownTags) {
      const opt = document.createElement('option');
      opt.value = t;
      el.knownTagsList.appendChild(opt);
    }
  }

  async function fetchTags() {
    try {
      const res = await fetch('/api/tags');
      knownTags = await res.json();
      refreshKnownTagsList();
    } catch { /* tag suggestions are a nicety, not critical */ }
  }

  function renderTagChips(row, item, card) {
    row.innerHTML = '';
    for (const tag of item.tags || []) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      const label = document.createElement('span');
      label.textContent = tag;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'tag-remove';
      remove.textContent = '×';
      remove.title = `Remove tag "${tag}"`;
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        mutateTag(item, tag, 'remove', row, card);
      });
      chip.append(label, remove);
      row.appendChild(chip);
    }
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'tag-add';
    addBtn.textContent = '+ tag';
    addBtn.title = 'Add tag';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startAddTag(row, item, card);
    });
    row.appendChild(addBtn);
  }

  function startAddTag(row, item, card) {
    if (row.querySelector('.tag-input')) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tag-input';
    input.placeholder = 'Tag name';
    input.setAttribute('list', 'known-tags');
    row.appendChild(input);
    input.focus();

    let done = false;
    function finish(commit) {
      if (done) return;
      done = true;
      input.removeEventListener('keydown', onKeydown);
      input.removeEventListener('blur', onBlur);
      const value = input.value.trim();
      input.remove();
      if (commit && value) mutateTag(item, value, 'add', row, card);
    }
    function onKeydown(e) {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    }
    function onBlur() { finish(true); }
    input.addEventListener('keydown', onKeydown);
    input.addEventListener('blur', onBlur);
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  async function mutateTag(item, tag, action, row, card) {
    try {
      const res = await fetch(`/api/assets/${item.id}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag, action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update tags');
      item.tags = data.tags;
      knownTags = data.allTags;
      refreshKnownTagsList();
      renderTagChips(row, item, card);
      rebuildFilterPills();
    } catch (e) {
      showToast(e.message);
    }
  }

  async function toggleHidden(item, card, btn) {
    const next = !item.hidden;
    btn.disabled = true;
    try {
      const res = await fetch(`/api/assets/${item.id}/hidden`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update');
      item.hidden = data.hidden;
      btn.textContent = item.hidden ? '👁️' : '🙈';
      btn.title = item.hidden ? 'Unhide' : 'Hide from browser';
      card.classList.toggle('is-hidden', item.hidden);
      if (item.hidden && !state.showHidden) removeCardFromView(item);
      rebuildFilterPills();
      showToast(item.hidden ? `Hidden: ${item.name}` : `Unhidden: ${item.name}`);
    } catch (e) {
      showToast(e.message);
    } finally {
      btn.disabled = false;
    }
  }

  function onFiltersChanged() {
    rebuildFilterPills();
    runSearch();
  }

  function runSearch() {
    filtered = applyFilters(allItems);
    shownCount = 0;
    el.grid.innerHTML = '';
    renderMore();
    el.status.textContent = `${filtered.length.toLocaleString()} of ${allItems.length.toLocaleString()} assets`;
  }

  function renderMore() {
    const next = filtered.slice(shownCount, shownCount + PAGE_SIZE);
    const frag = document.createDocumentFragment();
    for (const item of next) frag.appendChild(renderCard(item));
    el.grid.appendChild(frag);
    shownCount += next.length;
    el.loadMore.hidden = shownCount >= filtered.length;
  }

  function filesUrl(relPath) {
    return `/files/${relPath.split('/').map(encodeURIComponent).join('/')}`;
  }

  function isPreviewable(item) {
    return item.renderable || item.assetType === 'image' || item.assetType === 'audio';
  }

  function makeThumbImg(item) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = `${filesUrl(item.thumb)}?v=${Date.now()}`;
    img.alt = item.name;
    return img;
  }

  async function requestThumb(item, force) {
    const res = await fetch('/api/generate-thumb', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, force }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Generation failed');
    item.thumb = data.thumb;
  }

  function swapCardThumb(thumb, item) {
    thumb.querySelector('.placeholder')?.remove();
    thumb.querySelector('img')?.remove();
    thumb.prepend(makeThumbImg(item));
  }

  async function regenThumb(item, btn, thumb) {
    btn.disabled = true;
    btn.classList.remove('failed');
    btn.classList.add('busy');
    const prevTitle = btn.title;
    btn.title = 'Generating...';
    try {
      await requestThumb(item, true);
      swapCardThumb(thumb, item);
      showToast(`Preview generated: ${item.name}`);
      btn.title = prevTitle;
    } catch (e) {
      btn.classList.add('failed');
      btn.title = e.message;
      showToast(e.message);
    } finally {
      btn.disabled = false;
      btn.classList.remove('busy');
    }
  }

  let regenAllRunning = false;
  let regenAllCancel = false;

  async function regenAllPreviews() {
    if (regenAllRunning) {
      regenAllCancel = true;
      el.regenAll.disabled = true;
      el.regenAll.textContent = 'Stopping…';
      return;
    }

    const targets = filtered.filter((it) => it.renderable);
    if (!targets.length) {
      showToast('No renderable items in the current view');
      return;
    }

    regenAllRunning = true;
    regenAllCancel = false;
    el.regenAll.classList.add('active');
    let done = 0;
    let failed = 0;

    for (const item of targets) {
      if (regenAllCancel) break;
      el.regenAll.textContent = `Stop (${done}/${targets.length})`;
      try {
        await requestThumb(item, true);
        const card = el.grid.querySelector(`.card[data-id="${item.id}"] .thumb`);
        if (card) swapCardThumb(card, item);
      } catch {
        failed++;
      }
      done++;
    }

    const cancelled = regenAllCancel;
    regenAllRunning = false;
    regenAllCancel = false;
    el.regenAll.classList.remove('active');
    el.regenAll.disabled = false;
    el.regenAll.textContent = 'Regenerate all previews';
    showToast(cancelled
      ? `Stopped after ${done}/${targets.length} (${failed} failed)`
      : `Regenerated ${done - failed}/${targets.length} previews${failed ? `, ${failed} failed` : ''}`);
  }

  async function copyFile(item, btn) {
    btn.disabled = true;
    btn.classList.remove('failed');
    btn.classList.add('busy');
    try {
      const res = await fetch('/api/copy-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Copy failed');
      showToast(`Copied ${data.name} to clipboard`);
    } catch (e) {
      btn.classList.add('failed');
      btn.title = e.message;
      showToast(e.message);
    } finally {
      btn.disabled = false;
      btn.classList.remove('busy');
    }
  }

  function buildCardActions(item, thumb, card) {
    const bar = document.createElement('div');
    bar.className = 'card-actions';

    const hideBtn = document.createElement('button');
    hideBtn.className = 'icon-btn';
    hideBtn.type = 'button';
    hideBtn.textContent = item.hidden ? '👁️' : '🙈';
    hideBtn.title = item.hidden ? 'Unhide' : 'Hide from browser';
    hideBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleHidden(item, card, hideBtn);
    });

    const copyBtn = document.createElement('button');
    copyBtn.className = 'icon-btn';
    copyBtn.type = 'button';
    copyBtn.textContent = '📋';
    copyBtn.title = 'Copy file to clipboard';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyFile(item, copyBtn);
    });

    const regenBtn = document.createElement('button');
    regenBtn.className = 'icon-btn';
    regenBtn.type = 'button';
    regenBtn.textContent = '🔄';
    regenBtn.title = item.renderable ? 'Regenerate preview' : 'No renderable format available';
    regenBtn.disabled = !item.renderable;
    regenBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      regenThumb(item, regenBtn, thumb);
    });

    const revealBtn = document.createElement('button');
    revealBtn.className = 'icon-btn';
    revealBtn.type = 'button';
    revealBtn.textContent = '📁';
    revealBtn.title = 'Reveal in Explorer';
    revealBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      reveal(item);
    });

    bar.append(hideBtn, copyBtn, regenBtn, revealBtn);
    return bar;
  }

  function renderCard(item) {
    const card = document.createElement('div');
    card.className = 'card' + (item.hidden ? ' is-hidden' : '');
    card.dataset.id = item.id;
    card.title = item.renderable ? 'Click to open 3D viewer'
      : item.assetType === 'image' ? 'Click to view full size'
      : item.assetType === 'audio' ? 'Click to play'
      : 'Click to reveal in Explorer';

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (item.thumb) {
      thumb.appendChild(makeThumbImg(item));
    } else {
      const span = document.createElement('span');
      span.className = 'placeholder';
      span.textContent = PLACEHOLDER_ICON[item.assetType] || '❔';
      thumb.appendChild(span);
    }
    thumb.appendChild(buildCardActions(item, thumb, card));

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = item.name;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = [item.category, item.theme, item.pack].filter(Boolean).join(' / ');
    const formats = document.createElement('div');
    formats.className = 'formats';
    for (const f of item.formats) {
      const s = document.createElement('span');
      s.textContent = f;
      formats.appendChild(s);
    }
    const tagsRow = document.createElement('div');
    tagsRow.className = 'tags-row';
    renderTagChips(tagsRow, item, card);
    meta.append(name, sub, formats, tagsRow);
    card.append(thumb, meta);

    card.addEventListener('click', () => {
      if (isPreviewable(item)) openPreview(item);
      else reveal(item);
    });
    return card;
  }

  async function reveal(item) {
    try {
      const res = await fetch('/api/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id }),
      });
      if (!res.ok) throw new Error(await res.text());
      showToast(`Opened Explorer: ${item.name}`);
    } catch (e) {
      showToast('Could not open Explorer (is the server running on this machine?)');
    }
  }

  // ---- 3D viewer modal (F3D compiled to WebAssembly, https://github.com/f3d-app/f3d) ----

  const PLACEHOLDER_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  let placeholderPngCache = null;
  function placeholderPngBytes() {
    if (!placeholderPngCache) {
      const bin = atob(PLACEHOLDER_PNG_BASE64);
      placeholderPngCache = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) placeholderPngCache[i] = bin.charCodeAt(i);
    }
    return placeholderPngCache;
  }

  let f3dFactoryPromise = null;
  function loadF3DFactory() {
    if (!f3dFactoryPromise) {
      f3dFactoryPromise = import('/vendor/f3d/f3d.js').then((mod) => mod.default);
    }
    return f3dFactoryPromise;
  }

  let closeActiveViewer = null;

  // Shared modal shell (overlay + panel + header + close/escape/backdrop
  // wiring) for every preview type - 3D viewer, image lightbox, audio player.
  // `onClose` gets called for type-specific teardown (disposing the f3d
  // engine, pausing playback) before the overlay is removed.
  function createViewerShell(item, { bodyClass, onClose } = {}) {
    if (closeActiveViewer) closeActiveViewer();

    const overlay = document.createElement('div');
    overlay.className = 'viewer-overlay';

    const panel = document.createElement('div');
    panel.className = 'viewer-panel';

    const header = document.createElement('div');
    header.className = 'viewer-header';
    const title = document.createElement('div');
    title.className = 'viewer-title';
    title.textContent = item.name;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'viewer-close';
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Close';
    header.append(title, closeBtn);

    const body = document.createElement('div');
    body.className = 'viewer-body' + (bodyClass ? ` ${bodyClass}` : '');

    panel.append(header, body);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    let disposed = false;
    function close() {
      if (disposed) return;
      disposed = true;
      closeActiveViewer = null;
      document.removeEventListener('keydown', onKeydown);
      onClose?.();
      overlay.remove();
    }
    closeActiveViewer = close;

    function onKeydown(e) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKeydown);
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    return { body, close, isDisposed: () => disposed };
  }

  function openImagePreview(item) {
    const { body } = createViewerShell(item, { bodyClass: 'viewer-body-image' });
    const img = document.createElement('img');
    img.className = 'preview-image';
    img.src = filesUrl(item.previewPath);
    img.alt = item.name;
    img.onerror = () => showToast(`Could not load image: ${item.name}`);
    body.appendChild(img);
  }

  function openAudioPreview(item) {
    let audioEl = null;
    const { body } = createViewerShell(item, {
      bodyClass: 'viewer-body-audio',
      onClose: () => audioEl?.pause(),
    });
    const icon = document.createElement('div');
    icon.className = 'preview-audio-icon';
    icon.textContent = '🎵';
    audioEl = document.createElement('audio');
    audioEl.controls = true;
    audioEl.autoplay = true;
    audioEl.src = filesUrl(item.previewPath);
    audioEl.onerror = () => showToast(`Could not load audio: ${item.name}`);
    body.append(icon, audioEl);
  }

  async function openModelViewer(item) {
    let engine = null;
    let resizeObserver = null;
    const { body, isDisposed } = createViewerShell(item, {
      onClose: () => {
        resizeObserver?.disconnect();
        try { engine?.getInteractor()?.stop(); } catch { /* already gone */ }
        try { engine?.delete?.(); } catch { /* already gone */ }
      },
    });

    // F3D's wasm engine only binds its WebGL context to a canvas with the
    // literal id "canvas" (Engine.create() ignores any other selector and
    // silently fails to create a context - see https://github.com/f3d-app/f3d
    // webassembly bindings). createViewerShell() above guarantees at most one
    // of these exists in the DOM at a time, so reusing the id is safe.
    const canvasId = 'canvas';
    const canvas = document.createElement('canvas');
    canvas.id = canvasId;
    const status = document.createElement('div');
    status.className = 'viewer-status';
    status.innerHTML = '<span class="viewer-spinner"></span><span>Loading viewer…</span>';
    body.append(canvas, status);

    function setStatus(text, isError) {
      if (isDisposed()) return;
      status.classList.toggle('error', !!isError);
      status.innerHTML = isError
        ? `<span>⚠️ ${escapeHtml(text)}</span>`
        : `<span class="viewer-spinner"></span><span>${escapeHtml(text)}</span>`;
      status.hidden = false;
    }

    try {
      const [f3dFactory, assets] = await Promise.all([
        loadF3DFactory(),
        fetch(`/api/model-assets/${item.id}`).then(async (res) => {
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Failed to resolve model files');
          return data;
        }),
      ]);
      if (isDisposed()) return;

      setStatus('Starting renderer…');
      const Module = await f3dFactory({ canvas });
      if (isDisposed()) return;

      Module.Engine.autoloadPlugins();
      engine = Module.Engine.create(`#${canvasId}`);

      const options = engine.getOptions();
      options.setAsString('render.background.color', '#14161a');
      options.setAsString('render.effect.antialiasing.mode', 'fxaa');
      options.toggle('render.effect.tone_mapping');
      options.toggle('render.effect.ambient_occlusion');
      options.toggle('render.hdri.ambient');
      options.toggle('render.grid.enable');

      const scale = window.devicePixelRatio || 1;
      const win = engine.getWindow();
      win.setSize(Math.round(scale * canvas.clientWidth), Math.round(scale * canvas.clientHeight));

      setStatus('Fetching model files…');
      for (const f of assets.files) {
        const buf = await fetch(f.url).then((r) => r.arrayBuffer());
        const dir = f.relPath.split('/').slice(0, -1).join('/');
        if (dir) Module.FS.mkdirTree(dir);
        Module.FS.writeFile(f.relPath, new Uint8Array(buf));
      }
      // Referenced-but-missing textures (pack shipped incomplete) get a blank
      // placeholder so the loader finds a file at that path instead of hard-failing.
      for (const m of assets.missing || []) {
        const dir = m.relPath.split('/').slice(0, -1).join('/');
        if (dir) Module.FS.mkdirTree(dir);
        Module.FS.writeFile(m.relPath, placeholderPngBytes());
      }
      if (isDisposed()) return;

      const scene = engine.getScene();
      scene.add(assets.mainFile);
      win.render();
      engine.getInteractor().start();

      status.hidden = true;
      if (assets.missing?.length) {
        showToast(`Rendered with ${assets.missing.length} missing texture(s) - "${item.name}" pack looks incomplete`);
      }

      resizeObserver = new ResizeObserver(() => {
        if (isDisposed()) return;
        const s = window.devicePixelRatio || 1;
        win.setSize(Math.round(s * canvas.clientWidth), Math.round(s * canvas.clientHeight));
        win.render();
      });
      resizeObserver.observe(canvas);
    } catch (e) {
      console.error('viewer error', e);
      setStatus(e.message || 'Failed to open viewer', true);
    }
  }

  function openPreview(item) {
    if (item.assetType === 'image') return openImagePreview(item);
    if (item.assetType === 'audio') return openAudioPreview(item);
    return openModelViewer(item);
  }

  async function load() {
    el.status.textContent = 'Loading index...';
    const [assetsRes] = await Promise.all([fetch('/api/assets'), fetchTags()]);
    allItems = await assetsRes.json();
    rebuildFilterPills();
    runSearch();
  }

  el.search.addEventListener('input', debounce(() => {
    state.search = el.search.value;
    runSearch();
  }, 150));

  el.loadMore.addEventListener('click', renderMore);

  el.regenAll.addEventListener('click', regenAllPreviews);

  el.showHidden.addEventListener('change', () => {
    state.showHidden = el.showHidden.checked;
    onFiltersChanged();
  });

  el.clearFilters.addEventListener('click', () => {
    state.search = '';
    el.search.value = '';
    state.category.clear();
    state.theme.clear();
    state.pack.clear();
    state.tags.clear();
    onFiltersChanged();
  });

  el.rescan.addEventListener('click', async () => {
    el.rescan.disabled = true;
    el.rescan.textContent = 'Scanning...';
    try {
      await fetch('/api/rescan', { method: 'POST' });
      await load();
      showToast('Index refreshed');
    } finally {
      el.rescan.disabled = false;
      el.rescan.textContent = 'Rescan';
    }
  });

  load();
})();
