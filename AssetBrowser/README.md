# Asset Browser

A local, self-hosted web app for searching, tagging, and previewing a large game-dev asset library (3D models, images, audio) that lives on disk. It scans a folder tree once, keeps a persistent cache of your tags and hidden items, and serves a fast client-side searchable grid with real previews - a 3D viewer for models, a lightbox for images, and an inline player for audio - without needing Unity, Blender, or any DCC tool open.

It was built to browse a personal, informally organized asset dump (marketplace packs, downloaded kits, loose files) rather than a curated, single-convention repository, so the indexer is deliberately tolerant of messy folder structures.

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Running the server](#running-the-server)
- [Configuration](#configuration)
- [How the library is indexed](#how-the-library-is-indexed)
- [Using the browser](#using-the-browser)
- [Tagging](#tagging)
- [Previews](#previews)
- [API reference](#api-reference)
- [Project structure](#project-structure)
- [Platform support](#platform-support)
- [Troubleshooting](#troubleshooting)

## Features

- Recursively indexes an entire folder tree for 3D models, images, and audio, plus a catch-all bucket for everything else (archives, docs, tools).
- Collapses the same item shipped in multiple formats (e.g. `Anvil.fbx` / `Anvil.gltf` / `Anvil.obj`) into a single browsable card instead of three duplicates.
- In-browser 3D viewer (orbit, zoom) for glTF/GLB/OBJ/FBX models, running entirely client-side via F3D compiled to WebAssembly - no server round-trip once the files are fetched.
- Server-generated static thumbnails for models via the native F3D CLI, cached to disk next to the source file.
- Image lightbox and an inline audio player for everything else that has a preview.
- Free-text search plus faceted filtering by Tags, Theme, Pack, and Category, with live counts that narrow as other filters are applied.
- Manual tagging (add/remove, with autocomplete against every tag used so far) and automatic first-pass tagging based on file type and folder/name keywords.
- Hide/unhide items without touching anything on disk.
- One-click "reveal in Explorer" and "copy file to clipboard" (Windows only - see [Platform support](#platform-support)).
- "Regenerate all previews" to (re)render thumbnails in bulk for whatever the current filters/search are showing, with progress and the ability to stop mid-run.
- Nothing is ever written to, moved, or deleted from your asset library - the only files this app creates are the generated `*_thumb.png` thumbnails and its own local cache.

## Requirements

- **Node.js 18 or newer.**
- **F3D** (the native CLI, not the npm package) if you want server-generated 3D thumbnails. The in-browser 3D viewer does not need this - it uses the bundled WebAssembly build instead. Get it from [f3d.app](https://f3d.app) or the [F3D GitHub releases](https://github.com/f3d-app/f3d/releases). Either put the `f3d` executable on your `PATH`, or point `F3D_BIN` at it (see [Configuration](#configuration)).
- A modern browser (Chrome, Edge, Firefox, Safari) - the in-browser viewer needs WebGL and WebAssembly.

## Installation

From the `AssetBrowser` folder:

```bash
npm install
```

This pulls in `express` (the server) and `f3d` (the WebAssembly build used by the in-browser 3D viewer). No build step is required - it's plain CommonJS and vanilla JS on the frontend.

## Running the server

```bash
npm start
```

or directly:

```bash
node server.js
```

By default the server listens on **http://localhost:4747** and indexes the *parent* of the `AssetBrowser` folder (i.e. wherever you've dropped this tool inside your asset library). Open that URL in a browser once it prints `Asset browser running at http://localhost:<port>`.

Three convenience launch scripts are included, one level up from this folder - in the repo root, next to `AssetBrowser/` itself:

| Script | Platform | Usage |
|---|---|---|
| `start_asset_browser.bat` | Windows | Double-click in Explorer, or `start_asset_browser.bat` from a terminal |
| `start_asset_browser.sh` | Linux (and WSL) | `./start_asset_browser.sh` from a terminal |
| `start_asset_browser_mac.command` | macOS | Double-click in Finder, or `./start_asset_browser_mac.command` from a terminal |

All three resolve their own location and `cd` into the `AssetBrowser` folder next to them first (so it doesn't matter where you invoke them from), run `npm install` automatically the first time (or whenever `node_modules` is missing), warn you if no `f3d` binary can be found, and then start the server and open your default browser to it.

Stop the server with `Ctrl+C`.

## Configuration

All configuration is via environment variables - there is no config file.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4747` | Port the web server listens on. |
| `ASSETS_ROOT` | Parent folder of `AssetBrowser/` | Root of the library to index. Everything under this folder (except `AssetBrowser/` itself, and dotfiles/dotfolders) is scanned recursively. |
| `F3D_BIN` | `f3d` (resolved via `PATH`) | Path to the native F3D executable used to render thumbnails. |
| `PWSH_BIN` | `powershell.exe` | PowerShell executable used for the clipboard-copy feature (Windows only). |

Example - run against a different library root on a different port:

```bash
ASSETS_ROOT="/path/to/library" PORT=8080 node server.js
```

## How the library is indexed

The indexer (`indexer.js`) walks `ASSETS_ROOT` recursively and, for every folder that directly contains files, derives:

- **Category** - the top-level folder under the root.
- **Theme** - the folder directly under Category.
- **Pack** - the next meaningful folder after that, skipping folders that just describe a *format* rather than an item (`fbx`, `obj`, `gltf`, `glb`, `blend`, `textures`, `assets`, `samples`, etc.).

That format-folder skipping is what lets the same model exported as `Ship/FBX/Ship.fbx`, `Ship/OBJ/Ship.obj`, and `Ship/glTF/Ship.gltf` - or equally `fbx/Ship.fbx`, `obj/Ship.obj` at the pack root - collapse into **one** card with multiple format tags, regardless of which layout a given pack uses.

Files are then grouped into one of four asset types by extension:

| Asset type | Extensions | Notes |
|---|---|---|
| `model` | `fbx`, `obj`, `gltf`, `glb`, `blend` | Grouped across formats by matching base filename. Render/thumbnail priority is `glb` > `gltf` > `obj` > `fbx` (`.blend` has no loader available, so a `.blend`-only item has no preview). |
| `image` | `png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`, `svg` | The image file itself is used as its own thumbnail - nothing is generated. |
| `audio` | `mp3`, `wav`, `ogg`, `flac`, `m4a`, `aiff` | Covers both sound effects and music - there's no separate category, just whatever tags you give them. |
| `other` | everything else | Archives, tools, PDFs, whatever else lives in the tree. No preview; clicking reveals the file in Explorer. |

A few things are filtered out automatically: Unity `.meta` sidecars, OBJ `.mtl` material files and glTF `.bin` buffers (resolved directly by the model loaders instead), `Thumbs.db` / `desktop.ini`, dotfiles/dotfolders, `node_modules`, and filenames matching common boilerplate (`overview`, `preview`, `sample`, `readme`, `license`, `atlas`).

Re-scan the library at any time with the **Rescan** button in the header, or `POST /api/rescan`.

## Using the browser

- Type in the search box to filter by name, pack, or theme.
- Use the filter panel (Tags, Theme, Pack, Category) to narrow the grid; the counts on each pill reflect what's reachable given your *other* active filters, so picking a Theme immediately narrows the Pack list, and so on.
- Click a card to open its preview (3D viewer, image lightbox, or audio player) if it has one, otherwise it reveals the file in Explorer.
- Each card has four icon buttons: hide/unhide, copy file to clipboard, regenerate preview, and reveal in Explorer.
- **Show hidden** (top right) toggles whether hidden items are included in search/filter results at all.
- **Regenerate all previews** re-renders thumbnails for every renderable item currently matched by your search/filters, one at a time, and can be stopped mid-run.

## Tagging

Every asset gets an automatic first-pass tag the first time it's indexed:

- A type tag - `Image`, `Audio`, `Model` (plus `3D` specifically for models), or `Other`.
- Zero or more category guesses - `Character`, `Prop`, or `Environment` - based on keyword matches against the item's category/theme/pack/name (see `auto-tag.js` for the full keyword lists).

These are a starting point, not a guarantee - anything that doesn't match a keyword is left untagged beyond its type. Add or remove tags freely from a card; tag names you've used before are suggested via autocomplete. Tags and hidden state persist in `asset-cache.json` and survive a rescan (matched by a stable key derived from the item's type/category/theme/pack/path/name, not by file order).

## Previews

**Models** open in an in-browser 3D viewer (orbit with the mouse, scroll to zoom) built on F3D's WebAssembly build. The relevant model file plus every buffer/texture it references are resolved server-side and streamed into the viewer's virtual filesystem; a texture that's referenced but missing on disk gets a blank placeholder instead of failing the whole load.

Grid **thumbnails** for models are a separate, static PNG rendered server-side by the native F3D CLI and cached next to the source file as `<name>_thumb.png`. Generate one on demand with the regenerate button on a card, or in bulk with **Regenerate all previews**.

**Images** open in a simple full-size lightbox. **Audio** opens a modal with a native `<audio controls>` player. Neither needs a generation step - they're served directly from the library.

## API reference

All endpoints are JSON over HTTP, served by `server.js`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/assets` | Full current index. |
| `POST` | `/api/rescan` | Re-scan `ASSETS_ROOT` and rebuild the index. |
| `GET` | `/api/tags` | List every tag name used so far. |
| `POST` | `/api/tags` | Register a new tag name (`{ name }`) without applying it to anything. |
| `POST` | `/api/assets/:id/tags` | Add or remove a tag on one item (`{ tag, action: "add" \| "remove" }`). |
| `POST` | `/api/assets/:id/hidden` | Set an item's hidden state (`{ hidden }`). |
| `POST` | `/api/reveal` | Open Explorer with the item's file selected (`{ id }`). Windows only. |
| `POST` | `/api/copy-file` | Copy the item's file to the clipboard (`{ id }`). Windows only. |
| `POST` | `/api/generate-thumb` | (Re)generate a model's thumbnail via F3D (`{ id, force }`). |
| `GET` | `/api/model-assets/:id` | Resolve a model's main file plus every referenced sibling file, for the in-browser viewer. |
| `GET` | `/files/*` | Static, read-only access to anything under `ASSETS_ROOT`. |
| `GET` | `/vendor/f3d/*` | Serves the bundled F3D WebAssembly viewer build. |

## Project structure

```
AssetBrowser/
  server.js              Express server: indexing lifecycle, thumbnail generation, all API routes
  indexer.js              Recursive folder walk -> grouped, typed asset list
  cache.js                Loads/saves asset-cache.json; reconciles tags/hidden state across rescans
  auto-tag.js              Keyword-based first-pass tagging
  asset-cache.json         Persisted tags + hidden state (generated - not meant to be hand-edited)
  package.json
  public/
    index.html             App shell
    app.js                 All client-side logic: search/filters, cards, tagging UI, previews
    style.css               Styling
    icons/                 Material Icons SVGs used for the card action buttons
  start_asset_browser.bat          Windows launch script
  start_asset_browser.sh          Linux launch script
  start_asset_browser_mac.command  macOS launch script
```

## Platform support

The core app - indexing, tagging, search/filtering, 3D/image/audio previews, thumbnail generation - is plain Node.js and runs on Windows, Linux, and macOS alike (given Node and, if you want thumbnails, F3D for your platform).

Two features are Windows-only today, because they shell out to Windows-specific tools:

- **Reveal in Explorer** runs `explorer.exe /select,...`.
- **Copy file to clipboard** runs PowerShell's `Set-Clipboard`.

On Linux or macOS these two actions will fail with an error toast rather than silently doing nothing - everything else in the app is unaffected.

## Troubleshooting

**Thumbnail generation fails with `failed to load scene` / `No files loaded, no rendering performed`, but the in-browser preview for the same item opens fine.**

This was a real bug in F3D's native glTF/OBJ readers: they build a URI from the input file path, and reject characters like `[` and `]` - which show up constantly in asset-store pack folder names (e.g. `MegaKit[Standard]`). The in-browser viewer never hit this because it loads files over HTTP into a virtual filesystem instead of handing F3D a raw filesystem path. `server.js` now stages a bracket-free copy of the model (and whatever sibling files it references) into a temp directory before invoking F3D, so this should no longer happen - if it does, it's likely a different folder name using some other character F3D's URI parser rejects; the same fix applies.

**A model shows "No renderable format available" and its regenerate button is disabled.**

The item only has formats F3D can't load - currently just `.blend`. Export it to glTF/GLB/OBJ/FBX for a preview.

**A pack renders but with blank/untextured spots.**

The model references a texture file that isn't present on disk (the pack shipped incomplete). The in-browser viewer substitutes a placeholder and shows a toast telling you how many textures were missing; the item is otherwise usable.

**Reveal in Explorer / copy to clipboard silently fail on the same machine everything else works on.**

Confirm `PWSH_BIN` (default `powershell.exe`) is actually on `PATH`, or set it explicitly. On Linux/macOS these two features are not supported - see [Platform support](#platform-support).
