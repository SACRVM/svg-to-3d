/**
 * <app-svg-to-3d> — SVG → extruded 3D model, as a SACRVM APPKIT app
 * (kind: "view").
 *
 * Open, drop or paste an SVG; every filled shape becomes a solid of the
 * chosen thickness (holes stay holes), optionally with an outline band, one
 * mesh per SVG element, grouped per colour. Save it as GLB, OBJ or STL.
 *
 * What goes where:
 *   app.js     (this classic script) — the markup, the controls, file I/O.
 *   engine.js  (an ES module, imported on mount) — SVG parsing, extrusion,
 *              the Three.js viewer and the exporters. Three.js arrives from
 *              jsDelivr's +esm build, so no importmap is needed on a host.
 *
 * Layout: the app's own <sac-nav> (Open, GLB, OBJ, STL, SVG, Reset view,
 * Help), a .sidebar in a <sac-split>, the 3D viewport beside it. On a phone
 * the nav adopts the sidebar as its drawer.
 */
(function () {
    const BASE = sac.app.base();
    const CSS_ID = "app-svg-to-3d-css";
    const ENGINE = BASE + "engine.js";

    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const fmt = (n) => (Math.abs(n) >= 100 ? n.toFixed(1) : Math.abs(n) >= 1 ? n.toFixed(2) : n.toFixed(3));

    class AppSvgTo3d extends sac.app.Element {
        build() {
            sac.app.styles(BASE + "app.css", CSS_ID);
            this.innerHTML = `
<sac-nav brand="SVG TO 3D" brand-icon="shapes" brand-href="#/" host-nav="wide">
    <div slot="toolbar" class="toolbar">
        <button type="button" class="btn primary s3-open" title="Open an SVG">
            <sac-icon name="document"></sac-icon> Open
        </button>
        <button type="button" class="btn primary s3-export" data-format="glb" title="Save as GLB (binary glTF)" disabled>
            <sac-icon name="download"></sac-icon> GLB
        </button>
        <button type="button" class="btn s3-export" data-format="obj" title="Save as OBJ" disabled>OBJ</button>
        <button type="button" class="btn s3-export" data-format="stl" title="Save as STL (binary)" disabled>STL</button>
        <button type="button" class="btn s3-export" data-format="svg" title="Save the flattened, optimised SVG" disabled>SVG</button>
        <button type="button" class="nav-icon-btn s3-reset" title="Reset view"><sac-icon name="fit"></sac-icon></button>
        <button type="button" class="nav-icon-btn s3-help-btn" title="Help"><sac-icon name="info"></sac-icon></button>
    </div>
</sac-nav>

<div class="main-layout s3-root">
    <sac-split class="s3-split" position="22%" min-start="240px" min-end="320px"
               aria-label="Resize the control panel">

        <div class="sidebar fill s3-panel" slot="start">
            <sac-section title="Size">
                <div class="s3-grid">
                    <div><label for="s3-w">Width</label><input id="s3-w" class="s3-w" type="number" step="0.1" min="0" value="1"></div>
                    <div><label for="s3-h">Height</label><input id="s3-h" class="s3-h" type="number" step="0.1" min="0" value=""></div>
                    <div><label for="s3-t">Thickness</label><input id="s3-t" class="s3-t" type="number" step="0.01" min="0" value="0.1"></div>
                    <div><label for="s3-e">Elevation</label><input id="s3-e" class="s3-e" type="number" step="0.1" value="0"></div>
                </div>
                <p class="s3-note">Units are yours — glTF reads them as metres.</p>
            </sac-section>

            <sac-section title="Geometry">
                <sac-toggle class="s3-fill" label="Fill faces" checked></sac-toggle>
                <sac-toggle class="s3-outline" label="Outline edges"></sac-toggle>
                <div class="s3-outline-opts" hidden>
                    <div>
                        <label for="s3-ow">Outline width (SVG units)</label>
                        <input id="s3-ow" class="s3-ow" type="number" step="0.5" min="0.1" value="4">
                    </div>
                    <div>
                        <label>Outline align</label>
                        <sac-segmented-control class="s3-align" value="middle">
                            <button data-value="inset">Inset</button>
                            <button data-value="middle">Middle</button>
                            <button data-value="outset">Outset</button>
                        </sac-segmented-control>
                    </div>
                </div>
                <sac-toggle class="s3-upright" label="Upright (stand it up)"></sac-toggle>
                <div class="s3-grid">
                    <div><label for="s3-ry">Rotate Y (°)</label><input id="s3-ry" class="s3-ry" type="number" step="15" value="0"></div>
                </div>
                <sac-toggle class="s3-center" label="Center at origin" checked></sac-toggle>
            </sac-section>

            <sac-section title="Quality">
                <sac-slider class="s3-flat" label="Curve tolerance (lower = smoother)" min="0.1" max="5" step="0.1" value="0.5"></sac-slider>
                <sac-slider class="s3-red" label="Vertex reduction" min="0" max="2" step="0.1" value="0"></sac-slider>
                <div>
                    <label for="s3-gap">Layer stacking (0 = auto)</label>
                    <input id="s3-gap" class="s3-gap" type="number" step="0.001" min="0" value="0">
                </div>
            </sac-section>

            <sac-section title="Preview">
                <sac-segmented-control class="s3-mode" value="solid">
                    <button data-value="solid">Solid</button>
                    <button data-value="wire">Wireframe</button>
                </sac-segmented-control>
            </sac-section>
        </div>

        <div class="viewport s3-view" slot="end">
            <div class="s3-canvas"></div>
            <div class="empty-state s3-empty">
                <sac-icon name="shapes"></sac-icon>
                <b>Drop an SVG here, click Open, or paste one</b>
                <p>Logos, icons, lettering — every filled shape becomes a solid.</p>
            </div>
            <sac-hud class="s3-hud" position="bottom-left"></sac-hud>
            <div class="s3-busy" hidden><sac-spinner label="Working"></sac-spinner><span class="s3-busy-label">Loading 3D engine…</span></div>
        </div>

    </sac-split>
</div>

<sac-window class="s3-help-win" title="SVG to 3D Guide" width="500px" height="500px"
            left="calc(50vw - 250px)" top="12vh" controls="close">
    <div class="s3-help">
        <p>Turns a vector drawing into a 3D model: every <b>filled</b> shape becomes a solid of the chosen
           thickness, holes stay holes, each colour becomes its own group.</p>
        <ol>
            <li><b>Open</b>, drop or paste an <b>.svg</b> — paths, rects, circles, ellipses, polygons, lines.
                A photo or PNG is not a vector: trace it into an SVG first (the Vectorizer app does that).</li>
            <li>Set the <b>width</b> (or height — the other follows the aspect) and the <b>thickness</b>.</li>
            <li><b>Outline edges</b> adds a band along every contour (stroke colour if the SVG has one).
                <b>Upright</b> stands the model up facing +Z; <b>Rotate Y</b> turns it.</li>
            <li><b>Curve tolerance</b> and <b>vertex reduction</b> trade detail for triangle count.
                <b>Layer stacking</b> lifts each later shape a hair so overlapping colours never flicker.</li>
            <li>Save as <b>GLB</b> (with colours), <b>OBJ</b> or <b>STL</b> (geometry only, e.g. for printing).
                <b>SVG</b> saves the flattened, cleaned-up drawing.</li>
        </ol>
        <p>Drag to orbit, right-drag to pan, wheel to zoom.</p>
    </div>
</sac-window>
`;
        }

        onMount(context) {
            this._ctx = context;
            const $ = (s) => this.querySelector(s);
            const nav = $("sac-nav");
            if (nav) nav.host = context.host;

            this._view = $(".s3-view");
            this._hud = $(".s3-hud");
            this._busy = $(".s3-busy");
            this._busyLabel = $(".s3-busy-label");
            this._exportBtns = [...this.querySelectorAll(".s3-export")];
            this.ui = {
                w: $(".s3-w"), h: $(".s3-h"), t: $(".s3-t"), e: $(".s3-e"),
                fill: $(".s3-fill"), outline: $(".s3-outline"), outlineOpts: $(".s3-outline-opts"),
                ow: $(".s3-ow"), align: $(".s3-align"),
                upright: $(".s3-upright"), ry: $(".s3-ry"), center: $(".s3-center"),
                flat: $(".s3-flat"), red: $(".s3-red"), gap: $(".s3-gap"), mode: $(".s3-mode"),
            };

            this._svg = "";          // the source text
            this._parsed = null;     // parseSVG() result
            this._model = null;      // the current THREE.Group (owned by the viewer)
            this._name = "model";

            this._wire();

            // Paste only while on screen — a hidden view must not take another app's Ctrl+V.
            this._onPaste = (e) => this._paste(e);
            this._io = new IntersectionObserver((entries) => {
                this._setVisible(entries[entries.length - 1].isIntersecting);
            });
            this._io.observe(this);

            // The engine (and Three.js with it) loads now, in the background.
            this._engineReady = import(ENGINE).then((engine) => {
                this._engine = engine;
                this._viewer = engine.createViewer(this.querySelector(".s3-canvas"));
                return engine;
            }).catch((err) => {
                console.error("[svg-to-3d] could not load the 3D engine:", err);
                sac.toast?.("The 3D engine did not load — check the connection.", { kind: "error", duration: 0 });
                throw err;
            });
        }

        onUnmount() {
            this._setVisible(false);
            this._io?.disconnect();
            this._io = null;
            clearTimeout(this._rebuildTimer);
            clearTimeout(this._reparseTimer);
            this._viewer?.dispose();
            this._viewer = null;
        }

        _setVisible(on) {
            if (on === !!this._visible) return;
            this._visible = on;
            if (on) { document.addEventListener("paste", this._onPaste); this._viewer?.resize(); }
            else document.removeEventListener("paste", this._onPaste);
        }

        /* --------------------------------------------------------- wiring -- */

        /** Kit events only — composed native events from shadow inputs carry no detail. */
        _on(el, type, fn) {
            el.addEventListener(type, (e) => { if (e.detail != null) fn(e.detail.value); });
        }

        _wire() {
            const ui = this.ui;
            this.querySelector(".s3-open").addEventListener("click", () => this._open());
            this._exportBtns.forEach((b) => b.addEventListener("click", () => this._export(b.dataset.format)));
            this.querySelector(".s3-reset").addEventListener("click", () => this._viewer?.resetView());
            this.querySelector(".s3-help-btn").addEventListener("click", () => this.querySelector(".s3-help-win").open());

            const rebuild = () => this._scheduleRebuild();
            // Width and height are one size: typing one derives the other from the aspect.
            ui.w.addEventListener("input", () => { this._syncAspect("w"); rebuild(); });
            ui.h.addEventListener("input", () => { this._syncAspect("h"); rebuild(); });
            for (const el of [ui.t, ui.e, ui.ow, ui.ry, ui.gap]) el.addEventListener("input", rebuild);
            for (const el of [ui.fill, ui.upright, ui.center, ui.align]) this._on(el, "sac:change", rebuild);
            this._on(ui.outline, "sac:change", (v) => { ui.outlineOpts.hidden = !v; rebuild(); });
            this._on(ui.flat, "sac:input", () => this._scheduleReparse());
            this._on(ui.red, "sac:input", () => this._scheduleReparse());
            this._on(ui.mode, "sac:change", (v) => this._viewer?.setWireframe(v === "wire"));

            const view = this._view;
            ["dragenter", "dragover"].forEach((ev) =>
                view.addEventListener(ev, (e) => { e.preventDefault(); view.classList.add("dragover"); }));
            ["dragleave", "drop"].forEach((ev) =>
                view.addEventListener(ev, (e) => { e.preventDefault(); view.classList.remove("dragover"); }));
            view.addEventListener("drop", (e) => {
                const file = e.dataTransfer?.files?.[0];
                if (file) this._loadFile(file);
            });
        }

        _syncAspect(from) {
            const b = this._parsed?.bounds;
            if (!b || !b.w || !b.h) return;
            if (from === "w") {
                const w = parseFloat(this.ui.w.value);
                if (w > 0) this.ui.h.value = fmt(w * b.h / b.w);
            } else {
                const h = parseFloat(this.ui.h.value);
                if (h > 0) this.ui.w.value = fmt(h * b.w / b.h);
            }
        }

        /* ------------------------------------------------------------ files -- */

        async _open() {
            const picked = await this._ctx.files.open({ accept: ".svg,image/svg+xml", title: "Open SVG" });
            if (picked) this._loadFile(picked.file);
        }

        async _loadFile(file) {
            const isSvg = file && (/\.svg$/i.test(file.name || "") || file.type === "image/svg+xml");
            if (!isSvg) {
                sac.toast?.("That is not an SVG. Trace a pixel image into one first (Vectorizer).", { kind: "warn" });
                return;
            }
            this._load(await file.text(), (file.name || "model").replace(/\.[^.]+$/, ""));
        }

        _paste(e) {
            const cd = e.clipboardData;
            if (!cd) return;
            const file = [...(cd.files || [])].find((f) => f.type === "image/svg+xml" || /\.svg$/i.test(f.name));
            if (file) { e.preventDefault(); this._loadFile(file); return; }
            const text = cd.getData("text/plain") || "";
            if (/<svg[\s>]/i.test(text)) {
                e.preventDefault();
                this._load(text, "pasted");
            }
        }

        async _load(svgText, name) {
            this._svg = svgText;
            this._name = name || "model";
            this.ui.w.value = this.ui.w.value && parseFloat(this.ui.w.value) > 0 ? this.ui.w.value : "1";
            await this._reparse({ reframe: true, fitHeight: true });
        }

        _scheduleReparse() {
            clearTimeout(this._reparseTimer);
            this._reparseTimer = setTimeout(() => this._reparse({}), 150);
        }

        _scheduleRebuild() {
            clearTimeout(this._rebuildTimer);
            this._rebuildTimer = setTimeout(() => this._rebuild({}), 60);
        }

        async _reparse({ reframe = false, fitHeight = false }) {
            if (!this._svg) return;
            this._busy.hidden = false;
            this._busyLabel.textContent = "Loading 3D engine…";
            let engine;
            try { engine = await this._engineReady; }
            catch { this._busy.hidden = true; return; }
            this._busyLabel.textContent = "Building…";
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            try {
                this._parsed = engine.parseSVG(this._svg, { flatness: this.ui.flat.value, reduction: this.ui.red.value });
                if (!this._parsed.bounds) {
                    sac.toast?.("No shapes found in that SVG.", { kind: "warn" });
                    this._busy.hidden = true;
                    return;
                }
                if (fitHeight) this._syncAspect("w");
                this._rebuild({ reframe });
                this._view.classList.add("has-model");
            } catch (err) {
                console.error("[svg-to-3d] could not read the SVG:", err);
                sac.toast?.(`Could not read that SVG: ${err.message}`, { kind: "error" });
            }
            this._busy.hidden = true;
        }

        _options() {
            const ui = this.ui;
            return {
                width: ui.w.value, thickness: ui.t.value, elevation: ui.e.value,
                fill: ui.fill.checked, outline: ui.outline.checked,
                outlineWidth: ui.ow.value, outlineAlign: ui.align.value,
                upright: ui.upright.checked, rotateY: ui.ry.value, center: ui.center.checked,
                layerGap: ui.gap.value,
            };
        }

        _rebuild({ reframe = false }) {
            if (!this._engine || !this._parsed?.bounds) return;
            const { group, stats } = this._engine.buildModel(this._parsed, this._options());
            this._model = group;
            this._viewer.setModel(group, { reframe });
            const [x, y, z] = stats.size;
            this._hud.innerHTML =
                `<b>${esc(this._name)}</b><br>` +
                `${stats.meshes} mesh${stats.meshes === 1 ? "" : "es"} · ${stats.layers} colour${stats.layers === 1 ? "" : "s"} · ${Math.round(stats.triangles).toLocaleString()} tris<br>` +
                `${fmt(x)} × ${fmt(y)} × ${fmt(z)} units`;
            const ready = stats.meshes > 0;
            this._exportBtns.forEach((b) => { b.disabled = b.dataset.format === "svg" ? !this._parsed : !ready; });
        }

        async _export(format) {
            const engine = this._engine;
            if (!engine || !this._parsed?.bounds) return;
            let blob, ext;
            try {
                if (format === "glb") { blob = await engine.exportGLB(this._model); ext = ".glb"; }
                else if (format === "obj") { blob = engine.exportOBJ(this._model); ext = ".obj"; }
                else if (format === "stl") { blob = engine.exportSTL(this._model); ext = ".stl"; }
                else { blob = new Blob([engine.optimizedSVG(this._parsed)], { type: "image/svg+xml" }); ext = ".svg"; }
            } catch (err) {
                console.error("[svg-to-3d] export failed:", err);
                sac.toast?.("Export failed — see the console.", { kind: "error" });
                return;
            }
            const name = this._name + (format === "svg" ? "_optimized" : "") + ext;
            try {
                const saved = await this._ctx.files.save(blob, { name, accept: ext, title: `Save ${format.toUpperCase()}` });
                if (saved) sac.toast?.(`Saved ${saved.name}`, { kind: "success" });
            } catch (err) {
                console.error("[svg-to-3d] save failed:", err);
                sac.toast?.("Saving failed.", { kind: "error" });
            }
        }
    }

    sac.app.define("app-svg-to-3d", AppSvgTo3d);
})();
