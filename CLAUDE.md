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
background-remover, mesh-optimizer, svg-to-3d) — keep them identical:

1. **Toolbar order:** Open (`btn`, icon `folder`) · the main export
   (`btn primary`, icon `download`, labelled with its format) · further
   formats in a `sac-menu` "More ▾" · Copy (icon button, where it applies) ·
   the app's own icon buttons · Credits (`copyright`) · Help (`info`).
2. **Exports always ask** where to save — nothing is silently overwritten.
3. **Credits** open `sac.about` with the manifest's `notices` (licences).
4. **Empty state = `sac-drop-zone`**; its click opens through
   `context.files`, like the Open button.
5. **Settings are remembered:** every control with `data-keep` is stored in
   `context.fs` ("settings") and restored by replaying its event.
6. **Hotkeys through `sac.hotkeys`**, registered only while the app is on
   screen: Ctrl+O opens, Ctrl+S saves the main export.
7. **No prose on the UI.** Panels, sections and the empty state carry
   controls and short labels only; every explanation goes into the Help
   window.

The shell helpers (`_restoreSettings`, `_about`, `_wireDropZone`,
`_registerFileKeys`) are the same block in all four `app.js` files.

**Language:** chat in German, code/docs/commits in English.

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
