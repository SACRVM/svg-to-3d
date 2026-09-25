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
 * Layout: the app's own <sac-nav> (Open · GLB · More ▾ [OBJ, STL, SVG] ·
 * Reset view · Credits · Help), a .sidebar in a <sac-split>, the 3D viewport
 * beside it. On a phone the nav adopts the sidebar as its drawer.
 */
(function () {
    const BASE = sac.app.base();
    const CSS_ID = "app-svg-to-3d-css";
    const ENGINE = BASE + "engine.js";

    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const fmt = (n) => (Math.abs(n) >= 100 ? n.toFixed(1) : Math.abs(n) >= 1 ? n.toFixed(2) : n.toFixed(3));

    // The Quality sliders are levels; the engine takes tolerances (in 0.2 % of
    // the drawing's size — see parseSVG).
    const CURVE_TOL = [2, 1, 0.5, 0.25, 0.1];          // Coarse … Fine
    const REDUCTION_TOL = [0, 0.25, 0.5, 1, 2];        // Off … Max
    const level = (el, table) => table[Math.max(0, Math.min(table.length - 1, Math.round(parseFloat(el.value) || 0)))];
    const nearest = (table, v) => table.reduce((best, t, i) => (Math.abs(t - v) < Math.abs(table[best] - v) ? i : best), 0);

    class AppSvgTo3d extends sac.app.Element {
        build() {
            sac.app.styles(BASE + "app.css", CSS_ID);
            this.innerHTML = `
<sac-nav brand="SVG TO 3D" brand-icon="shapes" brand-href="#/" host-nav="wide">
    <div slot="context" class="s3-theme"><sac-theme-toggle></sac-theme-toggle></div>
    <div slot="toolbar" class="toolbar">
        <button type="button" class="btn s3-open" title="Open an SVG (Ctrl+O)">
            <sac-icon name="folder"></sac-icon> Open
        </button>
        <button type="button" class="btn primary s3-glb" title="Save as GLB — binary glTF (Ctrl+S)" disabled>
            <sac-icon name="download"></sac-icon> GLB
        </button>
        <sac-menu class="s3-formats">
            <button slot="trigger" type="button" class="btn s3-more" title="More formats" disabled>More <sac-icon name="chevron-down"></sac-icon></button>
            <button data-action="obj"><sac-icon name="download"></sac-icon> Save as OBJ</button>
            <button data-action="stl"><sac-icon name="download"></sac-icon> Save as STL</button>
            <button data-action="svg"><sac-icon name="download"></sac-icon> Save as SVG (flattened)</button>
        </sac-menu>
        <button type="button" class="nav-icon-btn s3-reset" title="Reset view"><sac-icon name="fit"></sac-icon></button>
        <button type="button" class="nav-icon-btn s3-credits" title="Credits &amp; licences"><sac-icon name="copyright"></sac-icon></button>
        <button type="button" class="nav-icon-btn s3-help-btn" title="Help"><sac-icon name="info"></sac-icon></button>
    </div>
</sac-nav>

<div class="main-layout s3-root">
    <sac-split class="s3-split" position="22%" min-start="240px" min-end="320px"
               aria-label="Resize the control panel">

        <div class="sidebar fill s3-panel" slot="start">
            <sac-section title="Size">
                <div class="s3-grid">
                    <div><label for="s3-w">Width</label><input id="s3-w" class="s3-w" type="number" step="0.1" min="0" value="1" data-keep="width"></div>
                    <div><label for="s3-h">Height</label><input id="s3-h" class="s3-h" type="number" step="0.1" min="0" value=""></div>
                    <div><label for="s3-t">Thickness</label><input id="s3-t" class="s3-t" type="number" step="0.01" min="0" value="0.1" data-keep="thickness"></div>
                    <div><label for="s3-e">Elevation</label><input id="s3-e" class="s3-e" type="number" step="0.1" value="0" data-keep="elevation"></div>
                </div>
            </sac-section>

            <sac-section title="Geometry">
                <sac-toggle class="s3-fill" label="Fill faces" checked data-keep="fill"></sac-toggle>
                <sac-toggle class="s3-outline" label="Outline edges" data-keep="outline"></sac-toggle>
                <div class="s3-outline-opts" hidden>
                    <div>
                        <label for="s3-ow">Outline width</label>
                        <input id="s3-ow" class="s3-ow" type="number" step="0.005" min="0.001" value="0.01" data-keep="outlineW">
                    </div>
                    <div>
                        <label>Outline align</label>
                        <sac-segmented-control class="s3-align" value="middle" data-keep="outlineAlign">
                            <button data-value="inset">Inset</button>
                            <button data-value="middle">Middle</button>
                            <button data-value="outset">Outset</button>
                        </sac-segmented-control>
                    </div>
                </div>
                <sac-toggle class="s3-upright" label="Upright" data-keep="upright"></sac-toggle>
                <div><label>Rotate Y</label><sac-stepper class="s3-ry" label="Rotate Y" min="0" max="355" step="5" value="0" unit="°" data-keep="rotateY"></sac-stepper></div>
                <sac-toggle class="s3-center" label="Center at origin" checked data-keep="center"></sac-toggle>
            </sac-section>

            <sac-section title="Quality" collapsible collapsed remember="svg-to-3d.quality">
                <sac-slider class="s3-flat" label="Curve detail" min="0" max="4" step="1" value="2"
                            labels="Coarse,Low,Medium,High,Fine" data-keep="curveDetail"></sac-slider>
                <sac-slider class="s3-red" label="Vertex reduction" min="0" max="4" step="1" value="0"
                            labels="Off,Light,Medium,Strong,Max" data-keep="reductionLevel"></sac-slider>
                <div>
                    <label for="s3-gap">Layer stacking (0 = auto)</label>
                    <input id="s3-gap" class="s3-gap" type="number" step="0.001" min="0" value="0" data-keep="layerGap">
                </div>
            </sac-section>

            <sac-section title="Preview">
                <sac-segmented-control class="s3-mode" value="solid" data-keep="preview">
                    <button data-value="solid">Solid</button>
                    <button data-value="wire">Wireframe</button>
                </sac-segmented-control>
            </sac-section>
        </div>

        <div class="viewport s3-view" slot="end">
            <div class="s3-canvas"></div>
            <div class="app-drop s3-empty">
                <sac-drop-zone class="on-viewport" accept=".svg,image/svg+xml" label="Drop an SVG" hint="or click to open"
                               touch-label="Open an SVG" touch-hint=""></sac-drop-zone>
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
           thickness, holes stay holes, each free-standing form is one closed body, each colour its own group.</p>
        <ol>
            <li><b>Open</b>, drop or paste an <b>.svg</b> — paths, rects, circles, ellipses, polygons, lines.
                A photo or PNG is not a vector: trace it into an SVG first (the Vectorizer app does that).</li>
            <li>Set the <b>width</b> (or height — the other follows the aspect) and the <b>thickness</b>.
                Units are yours: GLB / glTF read them as metres, OBJ and STL leave them to the importer.
                <b>Elevation</b> lifts the base off the ground.</li>
            <li><b>Outline edges</b> adds a band along every contour (stroke colour if the SVG has one);
                its <b>width</b> is in the same units as the model's width.
                In the fill colour it merges with the fill into one body; in another colour it is cut out
                of the fill, so the two touch without overlapping.
                <b>Upright</b> stands the model up facing +Z; <b>Rotate Y</b> turns it.</li>
            <li><b>Curve detail</b> sets how finely curves and arcs are sampled (Fine = smoothest, most
                triangles); <b>vertex reduction</b> thins out nearly-straight runs of points. Both trade detail
                for triangle count. <b>Layer stacking</b> lifts each later shape a hair so overlapping colours
                never flicker; 0 picks the step automatically.</li>
            <li>Save as <b>GLB</b> (with colours, Ctrl+S); <b>More</b> has <b>OBJ</b>, <b>STL</b> (geometry
                only, e.g. for printing) and <b>SVG</b> — the flattened, cleaned-up drawing. Every export asks
                where to save.</li>
        </ol>
        <p>Drag to orbit, right-drag to pan, wheel to zoom; the fit button resets the view.
           Ctrl+O opens a file. Your settings are remembered. Credits &amp; licences sit behind the ©
           button.</p>
    </div>
</sac-window>
`;
        }

        onMount(context) {
            this._ctx = context;
            const $ = (s) => this.querySelector(s);
            const nav = $("sac-nav");
            if (nav) nav.host = context.host;
            // Standalone the app brings its own theme switch; on a desktop the host has one.
            if (context.host) $(".s3-theme")?.remove();

            this._view = $(".s3-view");
            this._hud = $(".s3-hud");
            this._busy = $(".s3-busy");
            this._busyLabel = $(".s3-busy-label");
            this._glbBtn = $(".s3-glb");
            this._moreBtn = $(".s3-more");
            this._ready = false;     // a model with at least one mesh exists
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
                // A remembered "Wireframe" was replayed before the viewer existed.
                this._viewer.setWireframe(this.ui.mode.value === "wire");
                return engine;
            }).catch((err) => {
                console.error("[svg-to-3d] could not load the 3D engine:", err);
                sac.toast?.("The 3D engine did not load — check the connection.", { kind: "error", duration: 0 });
                throw err;
            });

            this._restoreSettings();
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
            if (on) {
                document.addEventListener("paste", this._onPaste);
                this._viewer?.resize();
                this._offFileKeys = this._registerFileKeys(() => { if (this._ready) this._export("glb"); });
            } else {
                document.removeEventListener("paste", this._onPaste);
                this._offFileKeys?.();
                this._offFileKeys = null;
            }
        }

        /* --------------------------------------------------------- wiring -- */

        /** Kit events only — composed native events from shadow inputs carry no detail. */
        _on(el, type, fn) {
            el.addEventListener(type, (e) => { if (e.detail != null) fn(e.detail.value); });
        }

        _wire() {
            const ui = this.ui;
            this.querySelector(".s3-open").addEventListener("click", () => this._open());
            this._glbBtn.addEventListener("click", () => this._export("glb"));
            this.querySelector(".s3-formats").addEventListener("sac:select", (e) => this._export(e.detail.action));
            this.querySelector(".s3-credits").addEventListener("click", () => this._about());
            this.querySelector(".s3-reset").addEventListener("click", () => this._viewer?.resetView());
            this.querySelector(".s3-help-btn").addEventListener("click", () => this.querySelector(".s3-help-win").open());

            const rebuild = () => this._scheduleRebuild();
            // Width and height are one size: typing one derives the other from the aspect.
            ui.w.addEventListener("input", () => { this._syncAspect("w"); rebuild(); });
            ui.h.addEventListener("input", () => { this._syncAspect("h"); rebuild(); });
            for (const el of [ui.t, ui.e, ui.ow, ui.gap]) el.addEventListener("input", rebuild);
            this._on(ui.ry, "sac:change", rebuild);
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
                if (e.composedPath().some((n) => n.tagName === "SAC-DROP-ZONE")) return;   // the zone reports its own
                const file = e.dataTransfer?.files?.[0];
                if (file) this._loadFile(file);
            });
            this._wireDropZone((file) => this._loadFile(file));
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
            if (!(parseFloat(this.ui.w.value) > 0)) this.ui.w.value = "1";
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
                this._parsed = engine.parseSVG(this._svg, { flatness: level(this.ui.flat, CURVE_TOL), reduction: level(this.ui.red, REDUCTION_TOL) });
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
            this._syncExports(stats.meshes > 0);
        }

        /** GLB, OBJ, STL need meshes; the flattened SVG only a parsed drawing. */
        _syncExports(ready) {
            this._ready = ready;
            this._glbBtn.disabled = !ready;
            this._moreBtn.disabled = !this._parsed;
            for (const b of this.querySelectorAll(".s3-formats [data-action]")) {
                b.disabled = b.dataset.action === "svg" ? !this._parsed : !ready;
            }
        }

        async _export(format) {
            const engine = this._engine;
            if (!engine || !this._parsed?.bounds) return;
            if (format !== "svg" && !this._ready) return;
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

        /* ------------------------------------------------ the app shell ---- *
         * Shared by the four DREAM-TOOLS-born apps (vectorizer, background-
         * remover, mesh-optimizer, svg-to-3d) — keep the copies in step.
         *   · settings: every control with data-keep is remembered in
         *     context.fs ("settings") and restored by replaying its event;
         *   · credits: sac.about from the manifest (notices included);
         *   · the empty state is a sac-drop-zone whose click goes through
         *     context.files (the host's file space), not the device picker.
         * ------------------------------------------------------------------ */

        _keepValue(el) {
            return el.tagName === "SAC-TOGGLE" ? el.checked : el.value;
        }

        async _restoreSettings() {
            let saved = null;
            try { saved = await this._ctx.fs?.read("settings", null); } catch { saved = null; }
            if (saved && typeof saved === "object" && this._migrateSettings) saved = this._migrateSettings(saved);
            if (saved && typeof saved === "object") {
                for (const el of this.querySelectorAll("[data-keep]")) {
                    const key = el.dataset.keep;
                    if (!(key in saved)) continue;
                    const v = saved[key];
                    const fire = (type, value) => el.dispatchEvent(new CustomEvent(type, { detail: { value }, bubbles: true }));
                    if (el.tagName === "SAC-TOGGLE") { el.checked = !!v; fire("sac:change", !!v); }
                    else if (el.tagName === "INPUT") { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); }
                    else if (el.tagName === "SAC-STEPPER") { el.value = Number(v); fire("sac:change", Number(v)); }
                    else if (el.tagName === "SAC-SLIDER") { el.value = String(v); fire("sac:input", String(v)); fire("sac:change", String(v)); }
                    else { el.value = String(v); fire("sac:change", String(v)); }
                }
            }
            // Watch only after restoring, so the replay above does not write back.
            const save = () => {
                clearTimeout(this._keepTimer);
                this._keepTimer = setTimeout(() => {
                    const out = {};
                    for (const el of this.querySelectorAll("[data-keep]")) out[el.dataset.keep] = this._keepValue(el);
                    Promise.resolve(this._ctx.fs?.write("settings", out)).catch(() => {});
                }, 400);
            };
            for (const el of this.querySelectorAll("[data-keep]")) {
                for (const type of ["sac:change", "sac:input", "input"]) el.addEventListener(type, save);
            }
        }

        /** Settings written by 1.2.x: raw tolerances become levels; the outline
         *  width was in SVG units, which cannot be converted without the drawing,
         *  so it falls back to the default. */
        _migrateSettings(saved) {
            const out = { ...saved };
            if ("flatness" in out && !("curveDetail" in out)) out.curveDetail = nearest(CURVE_TOL, parseFloat(out.flatness) || 0.5);
            if ("reduction" in out && !("reductionLevel" in out)) out.reductionLevel = nearest(REDUCTION_TOL, parseFloat(out.reduction) || 0);
            if ("rotateY" in out) out.rotateY = ((Math.round((parseFloat(out.rotateY) || 0) / 5) * 5) % 360 + 360) % 360;
            delete out.flatness; delete out.reduction; delete out.outlineWidth;
            return out;
        }

        async _about() {
            if (!this._manifest) {
                this._manifest = this._ctx.manifest
                    || await fetch(BASE + "app.json").then((r) => r.json()).catch(() => null);
            }
            if (sac.about) sac.about.open(this._manifest || { name: this.tagName.toLowerCase() });
        }

        _wireDropZone(onFile) {
            const wrap = this.querySelector(".app-drop");
            const zone = wrap.querySelector("sac-drop-zone");
            // Click / Enter / Space open through context.files, like the Open button.
            const intercept = (e) => {
                if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
                if (!e.composedPath().includes(zone)) return;
                e.preventDefault();
                e.stopPropagation();
                this._open();
            };
            wrap.addEventListener("click", intercept, true);
            wrap.addEventListener("keydown", intercept, true);
            zone.addEventListener("sac:files", (e) => { const f = e.detail.files[0]; if (f) onFile(f); });
            zone.addEventListener("sac:rejected", () => sac.toast?.("That file type does not open here.", { kind: "warn" }));
        }

        /** Ctrl+O / Ctrl+S — only while the app is on screen. */
        _registerFileKeys(saveFn) {
            const offs = [
                sac.hotkeys.register("mod+o", () => this._open(), { group: "File", description: "Open" }),
                sac.hotkeys.register("mod+s", () => saveFn(), { group: "File", description: "Save / export" }),
            ];
            return () => offs.forEach((off) => off());
        }
    }

    sac.app.define("app-svg-to-3d", AppSvgTo3d);
})();
