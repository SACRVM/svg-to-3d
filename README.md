# SVG to 3D

Turn SVG logos, icons and lettering into extruded 3D models — saved as GLB,
OBJ or STL. Runs entirely in the browser: no upload, no install, no build
step. Built on [SACRVM APPKIT](https://github.com/SACRVM/sacrvm-appkit); runs
standalone or as an app on a SACRVM desktop.

```bash
npx serve .
```

## What it does

Every filled shape of the drawing becomes a solid of the chosen thickness;
holes stay holes. Every free-standing form is ONE closed, watertight body —
fill and outline are computed as exact 2D regions (polygon booleans), not
stacked pieces — and the bodies are grouped by colour, so the model arrives in
any 3D tool already sorted and prints as-is.

- **Size:** set the width or the height (the other follows the aspect), the
  thickness and the elevation of the base.
- **Geometry:** fill faces, an optional outline band along every contour
  (inset, middle or outset; stroke colour where the SVG has one — in the fill
  colour it merges with the fill into one body, in another colour it is cut
  out of the fill so the two touch without overlapping), stand it upright,
  rotate it, centre it on the origin.
- **Quality:** curve tolerance and vertex reduction trade detail for
  triangles; layer stacking lifts each later shape a hair so overlapping
  colours never flicker.
- **Preview:** a real 3D view — orbit, pan, zoom, solid or wireframe. It shows
  exactly what gets saved.
- **In:** open, drop or paste an `.svg` — paths (curves and arcs included),
  rects, circles, ellipses, polygons, polylines, lines; transforms and
  gradients (their middle stop) are resolved. Pasting SVG markup works too,
  so the [Vectorizer](https://github.com/SACRVM/vectorizer)'s *Copy* lands
  here directly.
- **Out:** GLB (binary glTF, with colours), OBJ, STL (binary) — or the
  flattened, cleaned-up SVG. Every export asks where to save.
- **Remembers** your settings between sessions; Ctrl+O opens, Ctrl+S saves
  the GLB; credits and licences sit behind the © button.

## Install on a desktop

Paste `github.com/SACRVM/svg-to-3d` into a SACRVM desktop's install dialog,
or pick it from the App Store tab there.

## Credits

- [three.js](https://threejs.org/) 0.170.0 (MIT) — preview and exporters,
  loaded from jsDelivr on first use.
- Polygon triangulation based on [earcut](https://github.com/mapbox/earcut)
  (ISC, © Mapbox).
- Polygon booleans and offsets: [Clipper](https://sourceforge.net/projects/jsclipper/)
  (JavaScript port 6.4.2, Boost Software License, © Angus Johnson, JS port
  © Timo), loaded from jsDelivr.

## License

MIT — see `LICENSE`.
