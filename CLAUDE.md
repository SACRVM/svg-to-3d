# svg-to-3d

SVG → extruded 3D models (GLB / OBJ / STL) as an app built on
[SACRVM APPKIT](https://github.com/SACRVM/sacrvm-appkit). It started as the
SVG to World tool of DREAM TOOLS; everything specific to that game's world
format (primitive decomposition into Box/Prism1, the .world export, material
catalog, pivots) stayed behind. What is left is the generic core: SVG parsing,
curve flattening, simplification, triangulation — now emitted as real
meshes. The outline is NOT the old box-and-wedge construction (that only
existed because the game world could hold nothing but primitives): fill and
band are exact regions from Clipper booleans/offsets, and every free-standing
region becomes ONE closed, watertight body.

## The shape (same as every kit app)

**One repo, one app.** `app.json` (the manifest a desktop reads), `app.js`
(one custom element, classic script, guarded define), `app.css`, `index.html`
as the standalone harness, and `kit/` — the vendored kit. One addition:
`engine.js`, an ES module that `app.js` imports on mount (parsing, extrusion,
viewer, exporters).

- **No build step, ever.** Vanilla custom elements, plain CSS, `npx serve .`
  and F5.
- **The kit is vendored** (autark): `kit/` is the release ZIP's copy,
  verbatim — `kit/VERSION` says which — and never edited here. To upgrade,
  delete `kit/` and unzip the next release (see the appkit's `CONSUMING.md`).
  Use only the kit's documented API and its tokens — no raw colours in CSS.
- **Three.js via jsDelivr `+esm`, never an importmap.** On a desktop the app
  is injected into the host's page, which cannot carry our importmap. The
  `+esm` addon builds import `/npm/three@0.170.0/+esm`, so THREE and every
  addon share one instance — keep all three URLs on the same version.
- **Preview = export.** Orientation and placement are baked into the vertices
  in `buildModel()`; the viewer shows exactly the group the exporters get.
- **Carried code** (parsing, subdivision with the degenerate-chord guard,
  shared-edge simplification, earcut) is proven — change it deliberately, not
  in passing.
- **Solids** (`fillRegion` → `bandRegion` → `bodiesOf` → `extrudePieces`):
  fill = even-odd union of the element's contours; band = offset differences
  (inset `F∖shrink(F,w)`, middle `grow(F,w/2)∖shrink(F,w/2)`, outset
  `grow(F,w)∖F`, mitred, limit 4) plus open strokes for two-point lines. Same
  colour → union, one body; different colour → `fill∖band` + band, touching,
  never overlapping. Invariant, checked by test: every edge of every body is
  shared by exactly two triangles. Arcs are sampled for
  real here (`sampleArc`); the original only kept their endpoints.
- **Files go through the kit:** `context.files.open/save`, never a hand-made
  `<input type=file>` or download link.
- If the kit is missing something, route it to the appkit via Firepit instead
  of working around it here.

## UI conventions

Shared by the four apps that came out of DREAM TOOLS (vectorizer,
background-remover, mesh-optimizer, svg-to-3d) — keep them identical.

1. **Toolbar order:** Open (`btn`, icon `folder`, not primary) · main export
   (`btn primary`, icon `download`, label = format, pinned with
   `data-overflow="never"` — the ribbon's overflow folds from the end, so an
   unpinned primary would vanish into "…" on a phone while Open stays) · further
   formats in one `sac-menu` "More ▾" · Copy where it applies
   (`nav-icon-btn`) · app-specific icon buttons · Credits (`copyright`) · Help
   (`info`).
2. **Exports always ask** (Save as…) — no silent overwrite through a kept
   handle. Ctrl+S on an empty app does nothing.
3. **Credits via `sac.about`** from the manifest — the `notices` in `app.json`
   are what users see, keep them complete.
4. **Empty state = `sac-drop-zone`** in `.app-drop`, styled by the shared
   `.app-drop` CSS block (identical in all four `app.css`; the zone carries
   the kit's `on-viewport` class, because the viewport is black in both
   themes, plus one opaque `--glass` line — the kit's glass is translucent
   and the scene showed through; clears the label row and the HUD). Its
   click / Enter go through `context.files.open`, not
   the device picker.
5. **Settings are remembered:** controls with `data-keep="key"` are saved to
   `context.fs` ("settings") and replayed on mount through their kit event.
   Per-document values (e.g. a threshold fitted to one image) are not kept.
6. **Ctrl+O / Ctrl+S** (open / main export) through `sac.hotkeys`, registered
   only while the app is on screen.
7. **No prose on the UI.** Panels, windows and the empty state carry controls,
   short labels and data readouts only — every explanation goes into the Help
   window.

8. **View reset:** every app with a zoomable / orbitable view has a
   `nav-icon-btn` with icon `fit` in its app-specific icon group.
9. **Unsaved work is guarded** where the user edits something (not for pure
   parameter apps): `context.setDirty` on the first edit, cleared after a
   successful save; replacing a dirty document asks `sac.dialog.confirm`
   ("Discard unsaved changes?"). Never the native `confirm()`.
10. **Keyboard through `sac.hotkeys` only** — no raw keydown listeners for
    shortcuts; apps with more than Open/Save get a `keyboard` button and the
    `?` key opening a `sac-shortcut-sheet`. Hold-keys (Space to pan) go
    through `sac.hotkeys.hold` (kit ≥ 2.12).
11. **Feedback is visible:** results and warnings go to `sac.toast`, work that
    blocks for more than a moment shows a busy overlay — never console only.
12. **Kit controls with their limits:** `sac-stepper` only for short integers
    (its value field is 3ch wide); decimals stay kit-styled number inputs.
    Slider readouts carry a unit or named steps, never a bare technical number.
13. **Theme toggle** (`sac-theme-toggle` in the nav's `context` slot) only
    standalone — removed when `context.host` is set.
14. **Settings migrations** go through the snippet's `_migrateSettings(saved)`
    hook (sync, returns the migrated object) — the `_restoreSettings` snippet
    stays byte-identical in all four apps.

**Language:** chat in German, code/docs/commits in English.

## Develop, test, publish

Shared by the four apps that came out of DREAM TOOLS — keep identical.

- **Dev loop:** `npx serve . -l 3344` (Firepit command "Serve"), F5. `serve.json`
  disables caching.
- **Test both runtimes — they fail differently.** Standalone (`index.html`,
  vendored kit) AND installed on https://desktop.sacrvm.dev/ (the host's kit
  is live there; the app is injected into the host page). Recipe and a
  template script: global knowledge doc "Headless-testing SACRVM appkit apps"
  (`firepit_knowledge_search`). Stub `context.files.save/open` in tests —
  real pickers hang headless.
- **Always check:** dark + light theme + a 390px phone viewport (look at the
  screenshots), console clean, settings survive a reload, every export
  arrives, Ctrl+O / Ctrl+S.
- **Publish:** bump `version` in `app.json` (semver: fix = patch, feature =
  minor), commit, push to `main`. GitHub Pages serves `main` / root; wait
  until `https://sacrvm.github.io/<repo>/app.json` shows the new version,
  then re-test installed on the desktop. The repo carries the topic
  `sacrvm-app` → listed in the desktop's App Store. Desktops store the
  address, not a copy: every push is live for every installation.
- **Kit upgrade:** delete `kit/`, unzip the new release's `kit/` verbatim
  (`gh release download vX.Y.Z -R SACRVM/sacrvm-appkit`), check
  `CONSUMING.md` / `MIGRATION.md` for breakers, test both runtimes, commit
  "Vendor SACRVM APPKIT X.Y.Z". Never edit `kit/`.
- **Siblings:** vectorizer, background-remover, mesh-optimizer, svg-to-3d
  share the UI conventions and the `_restoreSettings` / `_about` /
  `_wireDropZone` / `_registerFileKeys` snippet byte-for-byte. A change to
  either belongs in all four — say so in the commit.

## Open items

Appkit 2.12.0 closed most reported gaps (vendored 2026-09-25): collapsible
`sac-section` (adopted: "Quality"), `.on-viewport`, `sac-menu` folding,
`canvas.natural` (n/a here — the viewer sizes its own canvas) and
`sac.hotkeys.hold` (n/a here — orbit controls, no Space-to-pan). Not adopted
yet: runtime language switching (`sac.lang`, `sac.t()`).

Still waiting on the appkit:
- `sac-stepper` width for decimals (still 3ch in 2.12.0) → width, height,
  thickness, elevation, outline width, layer gap become steppers.

Owner decisions open:
- **Accent colour:** own green vs following the desktop colour by default.
- Overlapping SVG elements of the same colour stay separate bodies (each
  element is its own set of closed bodies); unioning across elements was
  offered, not requested.
- App → app hand-off deferred (the shared file space bridges it).

## Firepit inbox

At the start of a session, read any pending messages in `.firepit/inbox/*.md` — cross-project notes Firepit routes here. Act on each, then mark it done with the `firepit_inbox_complete` MCP tool, passing the message's filename as the `id`.

## Firepit knowledge

Before researching something that may already be known, query the knowledge base with the `firepit_knowledge_search` MCP tool (scope `both` covers this project plus the global base). Save durable findings with `firepit_knowledge_add` — written in English, per the indexing convention. The created markdown files live under `.firepit/knowledge/` and are committed like any other file.

## Firepit pinned knowledge

@.firepit/knowledge-pinned.md

The import above auto-loads the knowledge docs marked `pin: true` in their frontmatter — always-on rules that apply every session without a search. Firepit regenerates the file from the pinned docs; don't edit it directly. Pin/unpin via the pinned flag on `firepit_knowledge_add` / `firepit_knowledge_update`, and keep the pinned set small — everything else stays reachable through `firepit_knowledge_search`.

## Firepit artifacts

When you produce a file the user will want to open — a report, screenshot, diagram, generated image, log excerpt, build output, or an executable you built for them to run — pin it with the `firepit_artifact_add` MCP tool so it appears in the project's paperclip pane. Do this as you produce it, not at the end of the session; a path buried in scrollback is a path the user has to hunt for. Pinning only links the file — it stays where it is, and `firepit_artifact_remove` never deletes it. Check `firepit_artifact_list` first so you update an existing entry instead of piling up near-duplicates, and unpin what has gone stale.

## Firepit conventions

<!-- claude-firepit-fragments -->

@../.firepit/projects/claude.md
@../.firepit/projects/claude-github-public.md

The two imports above are shared files in the Firepit central repo — edit them there and every project follows. They carry policy; the tools themselves are described by Firepit's MCP server at the handshake, so nothing is duplicated between the two.
