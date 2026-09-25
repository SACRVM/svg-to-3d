/**
 * SVG to 3D — the engine (an ES module, imported by app.js on mount).
 *
 * SVG → flattened contours → holes grouped by containment → earcut
 * triangles → extruded meshes (one per SVG element, grouped per colour) →
 * a Three.js preview and GLB / OBJ / STL export. What the preview shows is
 * exactly the group that gets exported (the orientation is baked into the
 * vertices, not left on a node transform).
 *
 * The SVG parsing, curve flattening (with its degenerate-chord guard),
 * topology-aware simplification, hole grouping, earcut and the outline band
 * construction are carried over from DREAM TOOLS' SVG to World, where they
 * were battle-tested. Elliptical arcs are now sampled for real (the original tool
 * only needed their endpoints).
 *
 * Three.js comes from jsDelivr's +esm build: the addons import
 * "/npm/three@0.170.0/+esm", so everything shares ONE three instance and no
 * importmap is needed (a desktop host could not provide one anyway).
 */
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.170.0/+esm";
import { OrbitControls } from "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/controls/OrbitControls.js/+esm";
import { GLTFExporter } from "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/exporters/GLTFExporter.js/+esm";
import { OBJExporter } from "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/exporters/OBJExporter.js/+esm";
import { STLExporter } from "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/exporters/STLExporter.js/+esm";

/* =========================================================================
   Elliptical arc → points (SVG 1.1 implementation notes, F.6.5 / F.6.6)
   ========================================================================= */
function sampleArc(p0, rx, ry, rotDeg, large, sweep, p1, flatness, pts) {
    rx = Math.abs(rx); ry = Math.abs(ry);
    if ((p0.x === p1.x && p0.y === p1.y)) return;
    if (rx === 0 || ry === 0) { pts.push({ x: p1.x, y: p1.y, t: 'corner' }); return; }
    const phi = rotDeg * Math.PI / 180, cos = Math.cos(phi), sin = Math.sin(phi);
    const dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2;
    const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
    const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (lambda > 1) { const k = Math.sqrt(lambda); rx *= k; ry *= k; }   // radii too small → scale up
    const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    let coef = Math.sqrt(Math.max(0, num / den));
    if (!!large === !!sweep) coef = -coef;
    const cx1 = coef * (rx * y1 / ry), cy1 = coef * (-ry * x1 / rx);
    const cx = cos * cx1 - sin * cy1 + (p0.x + p1.x) / 2;
    const cy = sin * cx1 + cos * cy1 + (p0.y + p1.y) / 2;
    const ang = (ux, uy, vx, vy) => {
        const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
        return a;
    };
    const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
    let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    else if (sweep && dt < 0) dt += 2 * Math.PI;
    // Segment count from the chord sagitta: r·(1 − cos(θ/2)) ≤ flatness.
    const r = Math.max(rx, ry), f = Math.max(1e-6, Math.min(flatness, r));
    const step = 2 * Math.acos(Math.max(-1, 1 - f / r));
    const n = Math.max(2, Math.min(512, Math.ceil(Math.abs(dt) / (step || 0.1))));
    for (let i = 1; i <= n; i++) {
        const t = t1 + dt * (i / n);
        const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
        pts.push({ x: cos * ex - sin * ey + cx, y: sin * ex + cos * ey + cy, t: 'curve' });
    }
}

/* =========================================================================
   Carried over from SVG to World (parsing → contours → triangles → outline)
   ========================================================================= */
function colorToHex(color) {
    const rgb = colorToRGBArray(color).map(v => Math.round(v * 255));
    return '#' + rgb.map(x => x.toString(16).padStart(2, '0')).join('');
}

function colorToRGBArray(color) {
    if (!color || color === 'none') return [1, 1, 1];
    const temp = document.createElement('div');
    temp.style.color = color;
    document.body.appendChild(temp);
    const style = window.getComputedStyle(temp).color;
    document.body.removeChild(temp);
    const matches = style.match(/\d+(\.\d+)?/g);
    if (!matches || matches.length < 3) return [1, 1, 1];
    // 3 decimals round-trips 8-bit color exactly (error ≤0.0005 × 255 = 0.13 < 0.5) — 4 was waste.
    return matches.slice(0, 3).map(x => parseFloat((parseFloat(x) / 255).toFixed(3)));
}


function extractCleanVertices(svgString, flatness) {
    // Strip XML declaration and DOCTYPE that can break HTML innerHTML parsing
    let cleaned = svgString
        .replace(/<\?xml[^?]*\?>\s*/gi, '')
        .replace(/<!DOCTYPE[^>]*>\s*/gi, '');

    // Replace percentage-based width/height with viewBox pixel values
    // (percentage dimensions cause zero-size SVG in hidden containers, breaking getCTM)

    const container = document.createElement('div');
    // Off-screen but rendered: getCTM() needs a laid-out SVG, the user must not see it.
    container.style.cssText = 'position:fixed;left:-100000px;top:0;opacity:0;pointer-events:none;';   // not visibility:hidden — that would hide every element from the check below
    container.innerHTML = cleaned;
    document.body.appendChild(container);
    const liveSvg = container.querySelector('svg');
    if (!liveSvg) { document.body.removeChild(container); throw new Error("No SVG element found"); }

    // Ensure dimensions match viewBox for consistent getCTM() results
    const vb = liveSvg.viewBox.baseVal;
    if (vb && vb.width > 0 && vb.height > 0) {
        liveSvg.setAttribute('width', vb.width);
        liveSvg.setAttribute('height', vb.height);
    }

    const pt = liveSvg.createSVGPoint(), shapes = [];
    liveSvg.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon').forEach((el, idx) => {
        // Skip elements inside <defs>, <clipPath> or <mask> which are often redundant or for metadata
        if (el.closest('defs, clipPath, mask')) return;

        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        const fill = el.getAttribute('fill') || style.fill || 'black';
        const resolvedColor = resolveSVGColor(liveSvg, fill);
        const stroke = el.getAttribute('stroke') || style.stroke || 'none';
        const strokeWidth = el.getAttribute('stroke-width') || style.strokeWidth || '1';
        const resolvedStroke = (stroke && stroke !== 'none') ? resolveSVGColor(liveSvg, stroke) : null;

        const subpaths = getEveryCoordinatePair(el, flatness);
        const ctm = el.getCTM();

        const tag = el.tagName.toLowerCase();
        let nativeShape = null;
        if (tag === 'circle' || tag === 'ellipse') nativeShape = 'cylinder';
        else if (tag === 'rect') nativeShape = 'box';

        // Layer grouping based on fill
        let layerId = fill;
        if (fill.startsWith('url')) {
            const match = fill.match(/#([^")]+)/);
            if (match) layerId = `Gradient: ${match[1]}`;
        }

        const elementSubpaths = [];
        subpaths.forEach((raw, subIdx) => {
            const transformed = raw.map(p => {
                pt.x = p.x; pt.y = p.y;
                const out = ctm ? pt.matrixTransform(ctm) : pt;
                return { x: out.x, y: out.y, t: p.t };
            });
            if (transformed.length > 0) {
                elementSubpaths.push({
                    vertices: transformed,
                    winding: calculateWinding(transformed)
                });
            }
        });

        if (elementSubpaths.length > 0) {
            shapes.push({
                name: `${el.tagName.toLowerCase()} #${idx + 1}`,
                subpaths: elementSubpaths,
                elementId: idx,
                docIndex: idx,
                layerId: layerId,
                resolvedColor: resolvedColor,
                resolvedStroke: resolvedStroke,
                visible: true,
                style: { fill, stroke, strokeWidth },
                nativeShape: nativeShape
            });
        }
    });
    document.body.removeChild(container);
    return shapes;
}

function resolveSVGColor(svg, fill) {
    if (!fill || fill === 'none' || fill === 'transparent') return '#10b981';
    if (fill.startsWith('#')) return fill;
    if (fill.startsWith('rgb')) return fill;

    if (fill.startsWith('url')) {
        const match = fill.match(/#([^")]+)/);
        if (match) {
            const id = match[1];
            const grad = svg.getElementById(id);
            if (grad) {
                const stops = grad.querySelectorAll('stop');
                if (stops.length > 0) {
                    const middleIdx = Math.floor(stops.length / 2);
                    const stop = stops[middleIdx];
                    // Check attribute, then inline style, then computed style
                    const stopColor = stop.getAttribute('stop-color') || stop.style.stopColor || window.getComputedStyle(stop).stopColor;
                    return (stopColor && stopColor !== 'none') ? stopColor : 'black';
                }
            }
        }
    }
    return fill;
}

function calculateWinding(pts) {
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
        let p1 = pts[i], p2 = pts[(i + 1) % pts.length];
        area += (p1.x * p2.y - p2.x * p1.y);
    }
    return area > 0 ? "CCW" : "CW";
}

// Point-to-segment squared distance for Douglas-Peucker
function getSqSegDist(p, p1, p2) {
    let x = p1.x, y = p1.y, dx = p2.x - x, dy = p2.y - y;
    if (dx !== 0 || dy !== 0) {
        let t = ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy);
        if (t > 1) { x = p2.x; y = p2.y; } else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = p.x - x; dy = p.y - y;
    return dx * dx + dy * dy;
}

function simplifyDPStep(points, first, last, sqTolerance, simplified) {
    let maxSqDist = sqTolerance, index;
    for (let i = first + 1; i < last; i++) {
        // ALWAYS preserve explicit 'corner' types if user wishes, but DP normally handles it.
        // We will just let DP calculate distance.
        let sqDist = getSqSegDist(points[i], points[first], points[last]);
        if (sqDist > maxSqDist) {
            index = i;
            maxSqDist = sqDist;
        }
    }
    if (maxSqDist > sqTolerance) {
        if (index - first > 1) simplifyDPStep(points, first, index, sqTolerance, simplified);
        simplified.push(points[index]);
        if (last - index > 1) simplifyDPStep(points, index, last, sqTolerance, simplified);
    }
}

// Global Douglas-Peucker: Simplifies shared edges simultaneously to prevent tearing.
// Strategy: Run DP on each whole subpath, then protect against degenerate collapse.
function simplifySharedEdgesGlobal(shapes, tolerance) {
    const sqTol = tolerance * tolerance;

    // --- Step 1: Run DP on each subpath independently ---
    shapes.forEach(shape => {
        shape.subpaths.forEach(sub => {
            const verts = sub.vertices;
            if (verts.length <= 3) return; // Nothing to simplify

            // For closed polygons, temporarily open them for DP
            const isClosed = verts.length > 2 &&
                Math.abs(verts[0].x - verts[verts.length - 1].x) < 0.001 &&
                Math.abs(verts[0].y - verts[verts.length - 1].y) < 0.001;

            const pts = isClosed ? verts.slice(0, -1) : [...verts];
            if (pts.length <= 2) return;

            // For closed polygons, use a rotating DP approach:
            // Find the point with max deviation from the line between its neighbors,
            // then run DP from that anchor point around the polygon.
            let simplified;
            if (isClosed) {
                // Find two anchor points: the two points farthest from each other
                let maxDist = -1, anchor1 = 0, anchor2 = 0;
                for (let i = 0; i < pts.length; i++) {
                    for (let j = i + 1; j < pts.length; j++) {
                        const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
                        const d = dx * dx + dy * dy;
                        if (d > maxDist) { maxDist = d; anchor1 = i; anchor2 = j; }
                    }
                }

                // Rotate so anchor1 is at index 0
                const rotated = pts.slice(anchor1).concat(pts.slice(0, anchor1));
                const newAnchor2 = (anchor2 - anchor1 + pts.length) % pts.length;

                // Run DP on the two halves (anchor1→anchor2, anchor2→anchor1)
                const half1 = rotated.slice(0, newAnchor2 + 1);
                const half2 = rotated.slice(newAnchor2).concat([rotated[0]]);

                const simp1 = [half1[0]];
                if (half1.length > 2) simplifyDPStep(half1, 0, half1.length - 1, sqTol, simp1);
                simp1.push(half1[half1.length - 1]);

                const simp2 = [half2[0]];
                if (half2.length > 2) simplifyDPStep(half2, 0, half2.length - 1, sqTol, simp2);
                simp2.push(half2[half2.length - 1]);

                // Merge: simp1 contains anchor1→anchor2, simp2 contains anchor2→anchor1
                // Remove duplicate anchor2 at junction
                simplified = simp1.concat(simp2.slice(1, -1));
            } else {
                // Open polyline — standard DP
                simplified = [pts[0]];
                simplifyDPStep(pts, 0, pts.length - 1, sqTol, simplified);
                simplified.push(pts[pts.length - 1]);
            }

            // --- Degenerate protection ---
            // For closed polygons: need at least 3 unique vertices
            if (isClosed) {
                // Count unique vertices
                const uniqueSet = new Set(simplified.map(p =>
                    Math.round(p.x * 1000) + "," + Math.round(p.y * 1000)
                ));
                if (uniqueSet.size < 3) {
                    // Reduction would collapse this shape — keep original
                    return;
                }
                // Re-close the polygon
                simplified.push({ ...simplified[0], t: simplified[0].t });
            }

            sub.vertices = simplified;
        });
    });
}

// ── DEGENERATE-CHORD GUARD (read before touching the flatness tests below) ──────────────
// Both subdividers stop on a flatness test that is RELATIVE to the chord p0→p3:
//     (d2 + d3)^2  <  flatness^2 * chordSq
// When p0 == p3 the chord is the zero vector, so chordSq = 0 AND d2/d3 (cross-products
// taken *against that same zero vector*) are also 0. The test degrades to `0 < 0` — FALSE
// — so it can never stop, not even though the curve is literally a single point. Each
// split of a zero-length curve yields two more zero-length curves, so it recursed until
// the JS stack died: "Maximum call stack size exceeded".
// This is not hypothetical input: Affinity/Serif SVG exporters emit zero-length cubics as
// path filler, e.g. "C231.24,199.838 231.24,199.838 231.24,199.838" with the pen already
// at that point. A `T` with no preceding Q does the same to the quad path (p1 := p0).
// With a zero chord the only meaningful measure of size is the control-hull spread from
// p0, so that is what we test instead. A genuine loop (p0 == p3 but the hull swinging
// wide) deliberately falls through to the split: its halves get distinct endpoints and the
// normal chord test takes over from there.
const CHORD_EPSILON_SQ = 1e-12;   // chord shorter than 1e-6 SVG units = degenerate
const CURVE_RECURSION_LIMIT = 32; // backstop only; legit curves bottom out around depth 13

function subdivideCubic(p0, p1, p2, p3, flatness, pts, depth = 0) {
    const dx = p3.x - p0.x, dy = p3.y - p0.y;
    const chordSq = dx * dx + dy * dy;
    const flatSq = flatness * flatness;

    if (chordSq < CHORD_EPSILON_SQ) {
        const h1 = (p1.x - p0.x) * (p1.x - p0.x) + (p1.y - p0.y) * (p1.y - p0.y);
        const h2 = (p2.x - p0.x) * (p2.x - p0.x) + (p2.y - p0.y) * (p2.y - p0.y);
        if (h1 <= flatSq && h2 <= flatSq) {   // the whole curve collapses to one point
            pts.push({ x: p3.x, y: p3.y, t: 'curve' });
            return;
        }
    }
    if (depth >= CURVE_RECURSION_LIMIT) {
        pts.push({ x: p3.x, y: p3.y, t: 'curve' });
        return;
    }

    const d2 = Math.abs((p1.x - p3.x) * dy - (p1.y - p3.y) * dx);
    const d3 = Math.abs((p2.x - p3.x) * dy - (p2.y - p3.y) * dx);
    if ((d2 + d3) * (d2 + d3) < flatSq * chordSq) {
        pts.push({ x: p3.x, y: p3.y, t: 'curve' });
        return;
    }
    const p01 = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
    const p12 = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const p23 = { x: (p2.x + p3.x) / 2, y: (p2.y + p3.y) / 2 };
    const p012 = { x: (p01.x + p12.x) / 2, y: (p01.y + p12.y) / 2 };
    const p123 = { x: (p12.x + p23.x) / 2, y: (p12.y + p23.y) / 2 };
    const p0123 = { x: (p012.x + p123.x) / 2, y: (p012.y + p123.y) / 2 };
    subdivideCubic(p0, p01, p012, p0123, flatness, pts, depth + 1);
    subdivideCubic(p0123, p123, p23, p3, flatness, pts, depth + 1);
}

function subdivideQuad(p0, p1, p2, flatness, pts, depth = 0) {
    const dx = p2.x - p0.x, dy = p2.y - p0.y;
    const chordSq = dx * dx + dy * dy;
    const flatSq = flatness * flatness;

    if (chordSq < CHORD_EPSILON_SQ) {
        const h1 = (p1.x - p0.x) * (p1.x - p0.x) + (p1.y - p0.y) * (p1.y - p0.y);
        if (h1 <= flatSq) {
            pts.push({ x: p2.x, y: p2.y, t: 'curve' });
            return;
        }
    }
    if (depth >= CURVE_RECURSION_LIMIT) {
        pts.push({ x: p2.x, y: p2.y, t: 'curve' });
        return;
    }

    const d = Math.abs((p1.x - p2.x) * dy - (p1.y - p2.y) * dx);
    if (d * d < flatSq * chordSq) {
        pts.push({ x: p2.x, y: p2.y, t: 'curve' });
        return;
    }
    const p01 = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
    const p12 = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const p012 = { x: (p01.x + p12.x) / 2, y: (p01.y + p12.y) / 2 };
    subdivideQuad(p0, p01, p012, flatness, pts, depth + 1);
    subdivideQuad(p012, p12, p2, flatness, pts, depth + 1);
}

function getEveryCoordinatePair(el, flatness) {
    const tag = el.tagName.toLowerCase(), numRegex = /-?\d*\.?\d+(?:[eE][-+]?\d+)?/g;
    let subpaths = [];
    if (tag === 'path') {
        const d = el.getAttribute('d') || "";
        const commands = d.match(/[MmLlHhVvCcSsQqTtAaZz][^MmLlHhVvCcSsQqTtAaZz]*/g) || [];
        let curr = { x: 0, y: 0 }, start = null, pts = [], lastCP = null, lastCmd = "";
        commands.forEach(cmd => {
            const type = cmd[0], args = cmd.match(numRegex)?.map(parseFloat) || [], T = type.toUpperCase(), isRel = type === type.toLowerCase();
            if (T === 'M') {
                if (pts.length > 0) subpaths.push(pts);
                pts = []; start = null; lastCP = null;
                for (let i = 0; i < args.length; i += 2) {
                    if (isRel) { curr.x += args[i]; curr.y += args[i + 1]; }
                    else { curr.x = args[i]; curr.y = args[i + 1]; }
                    if (!start) start = { ...curr };
                    pts.push({ ...curr, t: 'corner' });
                }
            } else if (T === 'L') {
                for (let i = 0; i < args.length; i += 2) {
                    if (isRel) { curr.x += args[i]; curr.y += args[i + 1]; }
                    else { curr.x = args[i]; curr.y = args[i + 1]; }
                    pts.push({ ...curr, t: 'corner' });
                }
                lastCP = null;
            } else if (T === 'H') {
                args.forEach(x => { if (isRel) curr.x += x; else curr.x = x; pts.push({ ...curr, t: 'corner' }); });
                lastCP = null;
            } else if (T === 'V') {
                args.forEach(y => { if (isRel) curr.y += y; else curr.y = y; pts.push({ ...curr, t: 'corner' }); });
                lastCP = null;
            } else if (T === 'C') {
                for (let i = 0; i < args.length; i += 6) {
                    const p1 = isRel ? { x: curr.x + args[i], y: curr.y + args[i + 1] } : { x: args[i], y: args[i + 1] };
                    const p2 = isRel ? { x: curr.x + args[i + 2], y: curr.y + args[i + 3] } : { x: args[i + 2], y: args[i + 3] };
                    const p3 = isRel ? { x: curr.x + args[i + 4], y: curr.y + args[i + 5] } : { x: args[i + 4], y: args[i + 5] };
                    subdivideCubic({ ...curr }, p1, p2, p3, flatness, pts);
                    curr = { ...p3 }; lastCP = p2;
                    if (pts.length > 0) pts[pts.length - 1].t = 'corner';
                }
            } else if (T === 'S') {
                for (let i = 0; i < args.length; i += 4) {
                    const p1 = (lastCmd === 'C' || lastCmd === 'S') ? { x: 2 * curr.x - lastCP.x, y: 2 * curr.y - lastCP.y } : { ...curr };
                    const p2 = isRel ? { x: curr.x + args[i], y: curr.y + args[i + 1] } : { x: args[i], y: args[i + 1] };
                    const p3 = isRel ? { x: curr.x + args[i + 2], y: curr.y + args[i + 3] } : { x: args[i + 2], y: args[i + 3] };
                    subdivideCubic({ ...curr }, p1, p2, p3, flatness, pts);
                    curr = { ...p3 }; lastCP = p2;
                    if (pts.length > 0) pts[pts.length - 1].t = 'corner';
                }
            } else if (T === 'Q') {
                for (let i = 0; i < args.length; i += 4) {
                    const p1 = isRel ? { x: curr.x + args[i], y: curr.y + args[i + 1] } : { x: args[i], y: args[i + 1] };
                    const p2 = isRel ? { x: curr.x + args[i + 2], y: curr.y + args[i + 3] } : { x: args[i + 2], y: args[i + 3] };
                    subdivideQuad({ ...curr }, p1, p2, flatness, pts);
                    curr = { ...p2 }; lastCP = p1;
                    if (pts.length > 0) pts[pts.length - 1].t = 'corner';
                }
            } else if (T === 'T') {
                for (let i = 0; i < args.length; i += 2) {
                    const p1 = (lastCmd === 'Q' || lastCmd === 'T') ? { x: 2 * curr.x - lastCP.x, y: 2 * curr.y - lastCP.y } : { ...curr };
                    const p2 = isRel ? { x: curr.x + args[i], y: curr.y + args[i + 1] } : { x: args[i], y: args[i + 1] };
                    subdivideQuad({ ...curr }, p1, p2, flatness, pts);
                    curr = { ...p2 }; lastCP = p1;
                    if (pts.length > 0) pts[pts.length - 1].t = 'corner';
                }
            } else if (T === 'A') {
                for (let i = 0; i < args.length; i += 7) {
                    const rx = args[i], ry = args[i + 1], rot = args[i + 2], large = args[i + 3], sweep = args[i + 4];
                    const p2 = isRel ? { x: curr.x + args[i + 5], y: curr.y + args[i + 6] } : { x: args[i + 5], y: args[i + 6] };
                    // A real elliptical arc (the original tool only needed its endpoint).
                    sampleArc(curr, rx, ry, rot, large, sweep, p2, flatness, pts);
                    if (pts.length > 0) pts[pts.length - 1].t = 'corner';
                    curr = { ...p2 }; lastCP = null;
                }
            } else if (T === 'Z' && start) { pts.push({ ...start, t: 'corner' }); lastCP = null; }
            lastCmd = T;
        });
        if (pts.length > 0) subpaths.push(pts);
    } else if (tag === 'rect') {
        const x = +el.getAttribute('x') || 0, y = +el.getAttribute('y') || 0, w = +el.getAttribute('width') || 0, h = +el.getAttribute('height') || 0;
        subpaths.push([{ x, y, t: 'corner' }, { x: x + w, y, t: 'corner' }, { x: x + w, y: y + h, t: 'corner' }, { x, y: y + h, t: 'corner' }, { x, y, t: 'corner' }]);
    } else if (tag === 'circle') {
        const cx = +el.getAttribute('cx') || 0, cy = +el.getAttribute('cy') || 0, r = +el.getAttribute('r') || 0;
        const pts = [];
        const steps = Math.max(12, Math.ceil(2 * Math.PI * r / flatness));
        for (let i = 0; i <= steps; i++) {
            const a = (i / steps) * Math.PI * 2;
            pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, t: 'curve' });
        }
        subpaths.push(pts);
    } else if (tag === 'ellipse') {
        const cx = +el.getAttribute('cx') || 0, cy = +el.getAttribute('cy') || 0, rx = +el.getAttribute('rx') || 0, ry = +el.getAttribute('ry') || 0;
        const pts = [];
        const steps = Math.max(12, Math.ceil(2 * Math.PI * Math.max(rx, ry) / flatness));
        for (let i = 0; i <= steps; i++) {
            const a = (i / steps) * Math.PI * 2;
            pts.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry, t: 'curve' });
        }
        subpaths.push(pts);
    } else if (tag === 'polyline' || tag === 'polygon') {
        const args = (el.getAttribute('points') || "").match(numRegex)?.map(parseFloat) || [];
        let pts = [];
        for (let i = 0; i < args.length; i += 2) pts.push({ x: args[i], y: args[i + 1], t: 'corner' });
        if (tag === 'polygon' && pts.length > 0) pts.push({ ...pts[0] });
        subpaths.push(pts);
    } else if (tag === 'line') {
        subpaths.push([{ x: +el.getAttribute('x1') || 0, y: +el.getAttribute('y1') || 0, t: 'corner' }, { x: +el.getAttribute('x2') || 0, y: +el.getAttribute('y2') || 0, t: 'corner' }]);
    }
    return subpaths;
}

// =============================================================================
// EARCUT — Minimal 2D polygon triangulation (supports holes)
// Based on https://github.com/mapbox/earcut (ISC License)
//
// ISC License — Copyright (c) 2016, Mapbox
// Permission to use, copy, modify, and/or distribute this software for any purpose
// with or without fee is hereby granted, provided that the above copyright notice
// and this permission notice appear in all copies.
// THE SOFTWARE IS PROVIDED "AS IS" AND ISC DISCLAIMS ALL WARRANTIES WITH REGARD TO
// THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS.
// IN NO EVENT SHALL ISC BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR
// CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA
// OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
// ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
// =============================================================================
function earcut(data, holeIndices, dim) {
    dim = dim || 2;
    const hasHoles = holeIndices && holeIndices.length;
    const outerLen = hasHoles ? holeIndices[0] * dim : data.length;
    let outerNode = linkedList(data, 0, outerLen, dim, true);
    const triangles = [];
    if (!outerNode || outerNode.next === outerNode.prev) return triangles;
    if (hasHoles) outerNode = eliminateHoles(data, holeIndices, outerNode, dim);
    let minX, minY, maxX, maxY, invSize;
    if (data.length > 80 * dim) {
        minX = maxX = data[0]; minY = maxY = data[1];
        for (let i = dim; i < outerLen; i += dim) {
            const x = data[i], y = data[i + 1];
            if (x < minX) minX = x; if (y < minY) minY = y;
            if (x > maxX) maxX = x; if (y > maxY) maxY = y;
        }
        invSize = Math.max(maxX - minX, maxY - minY);
        invSize = invSize !== 0 ? 32767 / invSize : 0;
    }
    earcutLinked(outerNode, triangles, dim, minX, minY, invSize, 0);
    return triangles;
}
function linkedList(data, start, end, dim, clockwise) {
    let last;
    if (clockwise === (signedArea(data, start, end, dim) > 0)) {
        for (let i = start; i < end; i += dim) last = insertNode(i, data[i], data[i + 1], last);
    } else {
        for (let i = end - dim; i >= start; i -= dim) last = insertNode(i, data[i], data[i + 1], last);
    }
    if (last && equals(last, last.next)) { removeNode(last); last = last.next; }
    if (!last) return last;
    last.next.prev = last; last.prev.next = last;
    return last;
}
function filterPoints(start, end) {
    if (!start) return start;
    if (!end) end = start;
    let p = start, again;
    do {
        again = false;
        if (!p.steiner && (equals(p, p.next) || area(p.prev, p, p.next) === 0)) {
            removeNode(p); p = end = p.prev; if (p === p.next) break;
            again = true;
        } else { p = p.next; }
    } while (again || p !== end);
    return end;
}
function earcutLinked(ear, triangles, dim, minX, minY, invSize, pass) {
    if (!ear) return;
    if (!pass && invSize) indexCurve(ear, minX, minY, invSize);
    let stop = ear, prev, next;
    while (ear.prev !== ear.next) {
        prev = ear.prev; next = ear.next;
        if (invSize ? isEarHashed(ear, minX, minY, invSize) : isEar(ear)) {
            triangles.push(prev.i / dim, ear.i / dim, next.i / dim);
            removeNode(ear); ear = next.next; stop = next.next; continue;
        }
        ear = next;
        if (ear === stop) {
            if (!pass) earcutLinked(filterPoints(ear), triangles, dim, minX, minY, invSize, 1);
            else if (pass === 1) { ear = cureLocalIntersections(filterPoints(ear), triangles, dim); earcutLinked(ear, triangles, dim, minX, minY, invSize, 2); }
            else if (pass === 2) splitEarcut(ear, triangles, dim, minX, minY, invSize);
            return;
        }
    }
}
function isEar(ear) {
    const a = ear.prev, b = ear, c = ear.next;
    if (area(a, b, c) >= 0) return false;
    const ax = a.x, bx = b.x, cx = c.x, ay = a.y, by = b.y, cy = c.y;
    const x0 = ax < bx ? (ax < cx ? ax : cx) : (bx < cx ? bx : cx);
    const y0 = ay < by ? (ay < cy ? ay : cy) : (by < cy ? by : cy);
    const x1 = ax > bx ? (ax > cx ? ax : cx) : (bx > cx ? bx : cx);
    const y1 = ay > by ? (ay > cy ? ay : cy) : (by > cy ? by : cy);
    let p = c.next;
    while (p !== a) {
        if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && pointInTriangle(ax, ay, bx, by, cx, cy, p.x, p.y) && area(p.prev, p, p.next) >= 0) return false;
        p = p.next;
    }
    return true;
}
function isEarHashed(ear, minX, minY, invSize) {
    const a = ear.prev, b = ear, c = ear.next;
    if (area(a, b, c) >= 0) return false;
    const ax = a.x, bx = b.x, cx = c.x, ay = a.y, by = b.y, cy = c.y;
    const x0 = ax < bx ? (ax < cx ? ax : cx) : (bx < cx ? bx : cx);
    const y0 = ay < by ? (ay < cy ? ay : cy) : (by < cy ? by : cy);
    const x1 = ax > bx ? (ax > cx ? ax : cx) : (bx > cx ? bx : cx);
    const y1 = ay > by ? (ay > cy ? ay : cy) : (by > cy ? by : cy);
    const minZ = zOrder(x0, y0, minX, minY, invSize), maxZ = zOrder(x1, y1, minX, minY, invSize);
    let p = ear.prevZ, n = ear.nextZ;
    while (p && p.z >= minZ && n && n.z <= maxZ) {
        if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && p !== a && p !== c && pointInTriangle(ax, ay, bx, by, cx, cy, p.x, p.y) && area(p.prev, p, p.next) >= 0) return false;
        p = p.prevZ;
        if (n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1 && n !== a && n !== c && pointInTriangle(ax, ay, bx, by, cx, cy, n.x, n.y) && area(n.prev, n, n.next) >= 0) return false;
        n = n.nextZ;
    }
    while (p && p.z >= minZ) {
        if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && p !== a && p !== c && pointInTriangle(ax, ay, bx, by, cx, cy, p.x, p.y) && area(p.prev, p, p.next) >= 0) return false;
        p = p.prevZ;
    }
    while (n && n.z <= maxZ) {
        if (n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1 && n !== a && n !== c && pointInTriangle(ax, ay, bx, by, cx, cy, n.x, n.y) && area(n.prev, n, n.next) >= 0) return false;
        n = n.nextZ;
    }
    return true;
}
function cureLocalIntersections(start, triangles, dim) {
    let p = start;
    do {
        const a = p.prev, b = p.next.next;
        if (!equals(a, b) && intersects(a, p, p.next, b) && locallyInside(a, b) && locallyInside(b, a)) {
            triangles.push(a.i / dim, p.i / dim, b.i / dim);
            removeNode(p); removeNode(p.next);
            p = start = b;
        }
        p = p.next;
    } while (p !== start);
    return filterPoints(p);
}
function splitEarcut(start, triangles, dim, minX, minY, invSize) {
    let a = start;
    do {
        let b = a.next.next;
        while (b !== a.prev) {
            if (a.i !== b.i && isValidDiagonal(a, b)) {
                let c = splitPolygon(a, b);
                a = filterPoints(a, a.next); c = filterPoints(c, c.next);
                earcutLinked(a, triangles, dim, minX, minY, invSize, 0);
                earcutLinked(c, triangles, dim, minX, minY, invSize, 0);
                return;
            }
            b = b.next;
        }
        a = a.next;
    } while (a !== start);
}
function eliminateHoles(data, holeIndices, outerNode, dim) {
    const queue = [];
    for (let i = 0, len = holeIndices.length; i < len; i++) {
        const start = holeIndices[i] * dim;
        const end = i < len - 1 ? holeIndices[i + 1] * dim : data.length;
        const list = linkedList(data, start, end, dim, false);
        if (list === list.next) list.steiner = true;
        queue.push(getLeftmost(list));
    }
    queue.sort((a, b) => a.x - b.x);
    for (let i = 0; i < queue.length; i++) {
        outerNode = eliminateHole(queue[i], outerNode);
    }
    return outerNode;
}
function eliminateHole(hole, outerNode) {
    const bridge = findHoleBridge(hole, outerNode);
    if (!bridge) return outerNode;
    const bridgeReverse = splitPolygon(bridge, hole);
    filterPoints(bridgeReverse, bridgeReverse.next);
    return filterPoints(bridge, bridge.next);
}
function findHoleBridge(hole, outerNode) {
    let p = outerNode, hx = hole.x, hy = hole.y, qx = -Infinity, m;
    do {
        if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
            const x = p.x + (hy - p.y) / (p.next.y - p.y) * (p.next.x - p.x);
            if (x <= hx && x > qx) { qx = x; m = p.x < p.next.x ? p : p.next; if (x === hx) return m; }
        }
        p = p.next;
    } while (p !== outerNode);
    if (!m) return null;
    const stop = m, mx = m.x, my = m.y;
    let tanMin = Infinity;
    p = m;
    do {
        if (hx >= p.x && p.x >= mx && hx !== p.x && pointInTriangle(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.x, p.y)) {
            const tan = Math.abs(hy - p.y) / (hx - p.x);
            if (locallyInside(p, hole) && (tan < tanMin || (tan === tanMin && (p.x > m.x || (p.x === m.x && sectorContainsSector(m, p)))))) { m = p; tanMin = tan; }
        }
        p = p.next;
    } while (p !== stop);
    return m;
}
function sectorContainsSector(m, p) { return area(m.prev, m, p.prev) < 0 && area(p.next, m, m.next) < 0; }
function indexCurve(start, minX, minY, invSize) {
    let p = start;
    do { if (p.z === 0) p.z = zOrder(p.x, p.y, minX, minY, invSize); p.prevZ = p.prev; p.nextZ = p.next; p = p.next; } while (p !== start);
    p.prevZ.nextZ = null; p.prevZ = null; sortLinked(p);
}
function sortLinked(list) {
    let i, p, q, e, tail, numMerges, pSize, qSize, inSize = 1;
    do {
        p = list; list = null; tail = null; numMerges = 0;
        while (p) {
            numMerges++; q = p; pSize = 0;
            for (i = 0; i < inSize; i++) { pSize++; q = q.nextZ; if (!q) break; }
            qSize = inSize;
            while (pSize > 0 || (qSize > 0 && q)) {
                if (pSize !== 0 && (qSize === 0 || !q || p.z <= q.z)) { e = p; p = p.nextZ; pSize--; }
                else { e = q; q = q.nextZ; qSize--; }
                if (tail) tail.nextZ = e; else list = e;
                e.prevZ = tail; tail = e;
            }
            p = q;
        }
        tail.nextZ = null; inSize *= 2;
    } while (numMerges > 1);
    return list;
}
function zOrder(x, y, minX, minY, invSize) {
    x = ((x - minX) * invSize) | 0; y = ((y - minY) * invSize) | 0;
    x = (x | (x << 8)) & 0x00FF00FF; x = (x | (x << 4)) & 0x0F0F0F0F; x = (x | (x << 2)) & 0x33333333; x = (x | (x << 1)) & 0x55555555;
    y = (y | (y << 8)) & 0x00FF00FF; y = (y | (y << 4)) & 0x0F0F0F0F; y = (y | (y << 2)) & 0x33333333; y = (y | (y << 1)) & 0x55555555;
    return x | (y << 1);
}
function getLeftmost(start) { let p = start, leftmost = start; do { if (p.x < leftmost.x || (p.x === leftmost.x && p.y < leftmost.y)) leftmost = p; p = p.next; } while (p !== start); return leftmost; }
function pointInTriangle(ax, ay, bx, by, cx, cy, px, py) { return (cx - px) * (ay - py) - (ax - px) * (cy - py) >= 0 && (ax - px) * (by - py) - (bx - px) * (ay - py) >= 0 && (bx - px) * (cy - py) - (cx - px) * (by - py) >= 0; }
function isValidDiagonal(a, b) { return a.next.i !== b.i && a.prev.i !== b.i && !intersectsPolygon(a, b) && (locallyInside(a, b) && locallyInside(b, a) && middleInside(a, b) && (area(a.prev, a, b.prev) || area(a, b.prev, b))); }
function area(p, q, r) { return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y); }
function equals(p1, p2) { return p1.x === p2.x && p1.y === p2.y; }
function intersects(p1, q1, p2, q2) { const o1 = sign(area(p1, q1, p2)), o2 = sign(area(p1, q1, q2)), o3 = sign(area(p2, q2, p1)), o4 = sign(area(p2, q2, q1)); if (o1 !== o2 && o3 !== o4) return true; if (o1 === 0 && onSegment(p1, p2, q1)) return true; if (o2 === 0 && onSegment(p1, q2, q1)) return true; if (o3 === 0 && onSegment(p2, p1, q2)) return true; if (o4 === 0 && onSegment(p2, q1, q2)) return true; return false; }
function onSegment(p, q, r) { return q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) && q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y); }
function sign(num) { return num > 0 ? 1 : num < 0 ? -1 : 0; }
function intersectsPolygon(a, b) { let p = a; do { if (p.i !== a.i && p.next.i !== a.i && p.i !== b.i && p.next.i !== b.i && intersects(p, p.next, a, b)) return true; p = p.next; } while (p !== a); return false; }
function locallyInside(a, b) { return area(a.prev, a, a.next) < 0 ? area(a, b, a.next) >= 0 && area(a, a.prev, b) >= 0 : area(a, b, a.prev) < 0 || area(a, a.next, b) < 0; }
function middleInside(a, b) { let p = a, inside = false; const px = (a.x + b.x) / 2, py = (a.y + b.y) / 2; do { if (((p.y > py) !== (p.next.y > py)) && p.next.y !== p.y && (px < (p.next.x - p.x) * (py - p.y) / (p.next.y - p.y) + p.x)) inside = !inside; p = p.next; } while (p !== a); return inside; }
function splitPolygon(a, b) { const a2 = createNode(a.i, a.x, a.y), b2 = createNode(b.i, b.x, b.y), an = a.next, bp = b.prev; a.next = b; b.prev = a; a2.next = an; an.prev = a2; b2.next = a2; a2.prev = b2; bp.next = b2; b2.prev = bp; return b2; }
function insertNode(i, x, y, last) { const p = createNode(i, x, y); if (!last) { p.prev = p; p.next = p; } else { p.next = last.next; p.prev = last; last.next.prev = p; last.next = p; } return p; }
function removeNode(p) { p.next.prev = p.prev; p.prev.next = p.next; if (p.prevZ) p.prevZ.nextZ = p.nextZ; if (p.nextZ) p.nextZ.prevZ = p.prevZ; }
function createNode(i, x, y) { return { i, x, y, prev: null, next: null, z: 0, prevZ: null, nextZ: null, steiner: false }; }
function signedArea(data, start, end, dim) { let sum = 0; for (let i = start, j = end - dim; i < end; i += dim) { sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]); j = i; } return sum; }

/** Point-in-polygon test (ray casting) */
function pointInPolygon(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
        if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi))
            inside = !inside;
    }
    return inside;
}

/** Group subpaths into outer contours + their holes using winding direction and containment */
function groupPathsWithHoles(shapes) {
    if (shapes.length === 0) return [];

    // 1. Calculate signed areas and absolute areas for sorting/depth
    const processed = shapes.map((item, i) => {
        const v = item.shape.vertices; // Accessing {vertices, winding} from subpathInfo
        let area = 0;
        for (let j = 0; j < v.length; j++) {
            const next = (j + 1) % v.length;
            area += (v[j].x * v[next].y - v[next].x * v[j].y);
        }
        return { item, absArea: Math.abs(area), idx: i };
    });

    // 2. Sort by absolute area (largest first)
    processed.sort((a, b) => b.absArea - a.absArea);

    const results = []; // Array of { shape, holes: [] }

    // 3. Containment-based grouping
    processed.forEach(entry => {
        let parentIdx = -1;
        let containers = 0;

        const v = entry.item.shape.vertices;
        const testPoints = [];

        let cx = 0, cy = 0;

        if (v.length >= 3) {
            // Because PolyBool cleanly bounds edges, the midpoint of any segment is guaranteed 100% on the path border.
            // Using a segment midpoint avoids bounding box centers which might be outside concave features.
            testPoints.push({ x: (v[0].x + v[1].x) / 2, y: (v[0].y + v[1].y) / 2 });
            testPoints.push({ x: (v[1].x + v[2].x) / 2, y: (v[1].y + v[2].y) / 2 });
            testPoints.push({ x: v[0].x, y: v[0].y });
        } else if (v.length > 0) {
            testPoints.push(v[0]);
        }

        for (let i = 0; i < processed.length; i++) {
            if (processed[i] === entry) continue;
            if (processed[i].absArea > entry.absArea) {
                const isInside = testPoints.some(pt => pointInPolygon(pt.x, pt.y, processed[i].item.shape.vertices));
                if (isInside) {
                    containers++;
                    if (parentIdx === -1 || processed[i].absArea < processed[parentIdx].absArea) {
                        parentIdx = i;
                    }
                }
            }
        }

        if (containers % 2 === 0) {
            const outer = { shape: entry.item.shape, holes: [], id: entry.idx };
            entry.groupRef = outer;
            results.push(outer);
        } else {
            if (parentIdx !== -1 && processed[parentIdx].groupRef) {
                processed[parentIdx].groupRef.holes.push(entry.item.shape);
            } else {
                const outer = { shape: entry.item.shape, holes: [], id: entry.idx };
                entry.groupRef = outer;
                results.push(outer);
            }
        }
    });

    return results;
}

/** Triangulate a polygon (with holes) and return array of triangle vertex arrays */
function triangulatePoly(outerVerts, holeShapes) {
    // Build flat coordinate array for earcut
    const coords = [];
    const holeIndices = [];

    // Outer ring
    outerVerts.forEach(v => { coords.push(v.x, v.y); });

    // Holes
    holeShapes.forEach(hole => {
        holeIndices.push(coords.length / 2);
        hole.vertices.forEach(v => { coords.push(v.x, v.y); });
    });

    // Triangulate
    const indices = earcut(coords, holeIndices.length > 0 ? holeIndices : null);

    // Extract triangles as vertex pairs
    const triangles = [];
    for (let i = 0; i < indices.length; i += 3) {
        const i0 = indices[i], i1 = indices[i + 1], i2 = indices[i + 2];
        triangles.push([
            { x: coords[i0 * 2], y: coords[i0 * 2 + 1] },
            { x: coords[i1 * 2], y: coords[i1 * 2 + 1] },
            { x: coords[i2 * 2], y: coords[i2 * 2 + 1] }
        ]);
    }
    return triangles;
}



/** Signed area of a 2D polygon (>0 = CCW in SVG's y-down space is CW visually; sign only used relatively) */
function polySignedArea(v) {
    let a = 0;
    for (let i = 0; i < v.length; i++) { const p = v[i], q = v[(i + 1) % v.length]; a += p.x * q.y - q.x * p.y; }
    return a / 2;
}

function outlineBoxSpecs(processedShapes, opts) {
    const T = Math.max(0.001, parseFloat(opts.width) || 4);
    const align = opts.align || 'middle';
    const halfW = T / 2;
    const MAXSEC = 4;                                   // miter limit (× half-width, SVG default 4): beyond
                                                        // this a very sharp corner is BEVELLED instead of
                                                        // shooting the apex far out as a thin floating shard.
    // inset/outset are NOT done by shifting each box perpendicular (that staggers the boxes at
    // corners and can't make asymmetric rails meet — the inset/outset breakage). Instead we
    // miter-offset the whole contour by ∓w/2 below and then build a CENTERED band on it, reusing
    // the exact machinery that works for middle. So the band math is always centred (cOff = 0).
    const bandOffset = align === 'inset' ? -halfW : (align === 'outset' ? halfW : 0);

    const boxes = [], tris = [];
    processedShapes.forEach(shape => {
        if (shape.visible === false) return;
        const color = shape.resolvedStroke || shape.resolvedColor;
        const docIndex = shape.docIndex, layerId = shape.layerId + ' (outline)';

        shape.subpaths.forEach(sub => {
            // WELD coincident vertices — consecutive AND wrap-around. Many SVGs repeat the start
            // point (explicit return-to-start L + a Z close → the start appears 2–3×). Removing only
            // ONE trailing duplicate left pts[0] and pts[M-1] coincident → a ZERO-LENGTH wrap edge,
            // whose garbage direction made dot≈0 at that one corner → misread as 90° → stuck w/2
            // overhang (the "one un-made corner per polygon", always at the seam). Collapsing all
            // coincident vertices makes the seam a single clean corner.
            const WELD = 1e-3;
            let pts = [];
            for (const v of sub.vertices) {
                if (!pts.length || Math.hypot(v.x - pts[pts.length - 1].x, v.y - pts[pts.length - 1].y) >= WELD) pts.push(v);
            }
            while (pts.length > 2 && Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y) < WELD) pts.pop();
            let M = pts.length;
            if (M < 2) return;

            // inset/outset: miter-offset the contour by bandOffset along the outward normal, then
            // treat it exactly as a centred band. Edge directions are preserved, so all the turn
            // angles (and thus the sharp/overhang classification) stay identical to middle.
            if (bandOffset !== 0 && M >= 3) {
                const aS = polySignedArea(pts) > 0 ? 1 : -1;
                const on = [];                                   // outward normals of the original contour
                for (let i = 0; i < M; i++) { const A = pts[i], B = pts[(i + 1) % M]; let dx = B.x - A.x, dy = B.y - A.y; const l = Math.hypot(dx, dy) || 1e-9; on.push({ x: (dy / l) * aS, y: -(dx / l) * aS }); }
                const off = [];
                for (let i = 0; i < M; i++) {
                    const np = on[(i - 1 + M) % M], nc = on[i];
                    let mx = np.x + nc.x, my = np.y + nc.y; const den = 1 + (np.x * nc.x + np.y * nc.y);
                    if (den > 1e-4) { mx /= den; my /= den; }
                    const ml = Math.hypot(mx, my) || 1e-9, CAP = 8; if (ml > CAP) { mx *= CAP / ml; my *= CAP / ml; }
                    off.push({ x: pts[i].x + bandOffset * mx, y: pts[i].y + bandOffset * my });
                }
                pts = off;
            }

            const d = [];                                        // per-edge unit dir + length
            for (let i = 0; i < M; i++) {
                const A = pts[i], B = pts[(i + 1) % M];
                let dx = B.x - A.x, dy = B.y - A.y; const l = Math.hypot(dx, dy) || 1e-9;
                dx /= l; dy /= l; d.push({ x: dx, y: dy, len: l });
            }
            // per-vertex: overhang e[i] (≤ halfW for ≥90° corners), sharp flag, sharp-tip apex.
            const e = new Array(M), sharp = new Array(M), apex = new Array(M);
            for (let i = 0; i < M; i++) {
                const dp = d[(i - 1 + M) % M], dc = d[i];
                let dot = dp.x * dc.x + dp.y * dc.y; dot = dot > 1 ? 1 : (dot < -1 ? -1 : dot);
                const crossZ = dp.x * dc.y - dp.y * dc.x;
                sharp[i] = dot < 0;                                       // interior < 90° (LOCAL — winding-independent)
                const f = Math.tan(Math.acos(dot) / 2);
                // Sharp tips: drop the overhang (e=0); the corner triangle fills the wedge instead.
                // ≥90° corners keep the math-derived overhang so their box outer corners meet.
                e[i] = sharp[i] ? 0 : halfW * Math.min(isFinite(f) ? f : 1, 1);
                // Sharp-tip apex on the LOCAL turn side sign(crossZ) — NOT the global winding — so the
                // triangle triggers for EVERY <90° corner. coef = gap-side rail offset = (w/2)·turnSign.
                const turnSign = crossZ >= 0 ? 1 : -1;
                const coef = halfW * turnSign;                           // centred band (offset baked into contour)
                const rp = { x: dp.y, y: -dp.x }, rc = { x: dc.y, y: -dc.x };   // right-hand normals
                let mx = rp.x + rc.x, my = rp.y + rc.y; const denom = 1 + dot;
                if (denom > 1e-4) { mx /= denom; my /= denom; }
                const ml = Math.hypot(mx, my) || 1e-9; if (ml > MAXSEC) { mx *= MAXSEC / ml; my *= MAXSEC / ml; }
                apex[i] = { x: pts[i].x + coef * mx, y: pts[i].y + coef * my };
            }
            // boxes (one per edge), extended by capped overhang at each end, centred on the contour
            for (let i = 0; i < M; i++) {
                const A = pts[i], B = pts[(i + 1) % M], di = d[i];
                if (di.len < 1e-6) continue;
                const ei = e[i], ej = e[(i + 1) % M];
                const sX = A.x - di.x * ei, sY = A.y - di.y * ei;
                const eX = B.x + di.x * ej, eY = B.y + di.y * ej;
                const cx = (sX + eX) / 2, cy = (sY + eY) / 2;             // centred (offset baked into contour)
                const boxLen = Math.hypot(eX - sX, eY - sY);
                if (boxLen < 1e-6) continue;
                boxes.push({ cx, cy, ux: di.x, uy: di.y, len: boxLen, width: T, color, docIndex, layerId });
            }
            // Sharp-convex corner fill. With overhang=0 the boxes meet at the vertex V but no
            // longer overlap, so the corner gap is the QUADRILATERAL (V → boxOuterCorner_prev →
            // miter apex → boxOuterCorner_cur). Filling only the outer triangle (inC,apex,outC)
            // leaves the inner part near V open (the dark notch). Cover the whole quad as a fan
            // from V: (V,inC,apex)+(V,apex,outC). Each tri becomes one extruded wedge.
            for (let i = 0; i < M; i++) {
                if (!sharp[i]) continue;                                     // e[i] = 0 here (sharp)
                const dp = d[(i - 1 + M) % M], dc = d[i], V = pts[i];
                const crossZ = dp.x * dc.y - dp.y * dc.x;
                const coef = halfW * (crossZ >= 0 ? 1 : -1);                 // gap-side rail offset (centred band)
                const rp = { x: dp.y, y: -dp.x }, rc = { x: dc.y, y: -dc.x };
                const inC = { x: V.x + coef * rp.x, y: V.y + coef * rp.y };   // prev edge gap-side corner @ V
                const outC = { x: V.x + coef * rc.x, y: V.y + coef * rc.y };  // cur edge gap-side corner @ V
                const ap = apex[i], Vp = { x: V.x, y: V.y };
                const tri2 = (a, b, c) => {
                    const ar = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
                    if (ar > 1e-6) tris.push({ a, b, c, color, docIndex, layerId });
                };
                tri2(Vp, inC, ap); tri2(Vp, ap, outC);
            }
        });
    });
    return { boxes, tris };
}

/* =========================================================================
   Parse: SVG text → shapes (+ bounds). Tolerances scale with the drawing.
   ========================================================================= */
export function parseSVG(svgString, { flatness = 0.5, reduction = 0 } = {}) {
    // Adaptive precision: tolerances are relative to the drawing's size.
    let refScale = 1000;
    const vbMatch = svgString.match(/viewBox\s*=\s*"([^"]+)"/i);
    if (vbMatch) {
        const vb = vbMatch[1].split(/[\s,]+/).map(Number);
        if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) refScale = Math.max(vb[2], vb[3]);
    } else {
        const wMatch = svgString.match(/width\s*=\s*"([^"]+)"/i);
        const hMatch = svgString.match(/height\s*=\s*"([^"]+)"/i);
        if (wMatch && hMatch) refScale = Math.max(parseFloat(wMatch[1]), parseFloat(hMatch[1])) || 1000;
    }
    const scaleFactor = (refScale / 1000) * 2;
    const shapes = extractCleanVertices(svgString, parseFloat(flatness) * scaleFactor);
    const reductionTol = parseFloat(reduction) * scaleFactor;
    if (reductionTol > 0) simplifySharedEdgesGlobal(shapes, reductionTol);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, verts = 0;
    shapes.forEach((s) => s.subpaths.forEach((sub) => sub.vertices.forEach((v) => {
        if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
        if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
        verts++;
    })));
    if (!verts) return { shapes, bounds: null, verts: 0 };
    return { shapes, verts, bounds: { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY } };
}

/** The flattened contours as a plain SVG (fill-rule evenodd keeps the holes). */
export function optimizedSVG(parsed) {
    const b = parsed.bounds, pad = 10;
    let svg = `<svg viewBox="${b.minX - pad} ${b.minY - pad} ${b.w + pad * 2} ${b.h + pad * 2}" xmlns="http://www.w3.org/2000/svg" fill-rule="evenodd">\n`;
    const groups = {};
    parsed.shapes.forEach((s) => {
        if (!groups[s.elementId]) groups[s.elementId] = { d: "", style: s.style };
        s.subpaths.forEach((sub) => {
            groups[s.elementId].d += sub.vertices.map((v, i) => `${i === 0 ? "M" : "L"} ${v.x.toFixed(3)} ${v.y.toFixed(3)}`).join(" ") + " Z ";
        });
    });
    Object.values(groups).forEach((g) => {
        svg += `  <path d="${g.d.trim()}" fill="${g.style.fill}" stroke="${g.style.stroke}" stroke-width="${g.style.strokeWidth}" />\n`;
    });
    return svg + "</svg>\n";
}

/* =========================================================================
   Build: shapes → extruded meshes
   ========================================================================= */

/**
 * Extrude flat pieces (each an array of 2D triangles) into a closed slab from
 * y0 to y1. Top/bottom are the triangles; walls stand on every edge used by
 * exactly one triangle of its piece (the piece's boundary, holes included).
 * Carried from SVG to World's glTF export, where the winding was verified.
 */
function extrudePieces(pieces, scale, y0, y1) {
    const pos = [];
    const push = (a, b, c) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    const V = (p, y) => ({ x: p.x, y, z: p.z });
    for (const tris of pieces) {
        const edgeCounts = new Map(), edgeOf = new Map();
        for (const tri of tris) {
            let p0 = { x: tri[0].x * scale, z: tri[0].y * scale };
            let p1 = { x: tri[1].x * scale, z: tri[1].y * scale };
            let p2 = { x: tri[2].x * scale, z: tri[2].y * scale };
            const area = (p1.x - p0.x) * (p2.z - p0.z) - (p1.z - p0.z) * (p2.x - p0.x);
            if (Math.abs(area) < 1e-14) continue;
            if (area > 0) { const t = p1; p1 = p2; p2 = t; }   // top face must point +Y
            push(V(p0, y0), V(p2, y0), V(p1, y0));             // bottom, facing down
            push(V(p0, y1), V(p1, y1), V(p2, y1));             // top, facing up
            for (const [a, b] of [[p0, p1], [p1, p2], [p2, p0]]) {
                const kA = `${a.x.toFixed(6)}_${a.z.toFixed(6)}`, kB = `${b.x.toFixed(6)}_${b.z.toFixed(6)}`;
                const key = kA < kB ? `${kA}|${kB}` : `${kB}|${kA}`;
                if (!edgeCounts.has(key)) { edgeCounts.set(key, 0); edgeOf.set(key, [a, b]); }
                edgeCounts.set(key, edgeCounts.get(key) + 1);
            }
        }
        for (const [key, n] of edgeCounts) {
            if (n !== 1) continue;
            const [a, b] = edgeOf.get(key);
            push(V(a, y0), V(b, y0), V(b, y1));
            push(V(a, y0), V(b, y1), V(a, y1));
        }
    }
    if (!pos.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();   // non-indexed → flat, hard-edged shading
    return geo;
}

function colorHex(color) {
    const rgb = colorToRGBArray(color).map((v) => Math.round(v * 255));
    return "#" + rgb.map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Build the model. Every length is in output units: `width` is the model's
 * width, the rest follows from the SVG's aspect.
 *   opts: { width, thickness, elevation, fill, outline, outlineWidth,
 *           outlineAlign, upright, rotateY, center, layerGap }
 * → { group, stats } — group holds only meshes (the exported object).
 */
export function buildModel(parsed, opts) {
    const group = new THREE.Group();
    group.name = "svg-to-3d";
    const stats = { meshes: 0, triangles: 0, layers: 0, size: [0, 0, 0] };
    if (!parsed || !parsed.bounds) return { group, stats };

    const b = parsed.bounds;
    const scale = (parseFloat(opts.width) > 0 ? parseFloat(opts.width) : b.w) / (b.w || 1);
    const thickness = Math.max(1e-6, parseFloat(opts.thickness) || 0.1);
    const shapes = parsed.shapes.filter((s) => s.visible !== false);

    // Layer stacking: each later element sits a hair above the one before, so
    // overlapping colours never z-fight. 0 = auto (0.1 % of the width per
    // step, the whole stack capped at 1 % of the width).
    const W = b.w * scale;
    const maxDoc = Math.max(0, ...shapes.map((s) => s.docIndex || 0));
    const typedGap = parseFloat(opts.layerGap);
    const gap = typedGap > 0 ? typedGap : (maxDoc > 0 ? Math.min(W * 0.001, (W * 0.01) / maxDoc) : 0);
    const lift = gap || W * 0.001;   // the outline band stands this much proud of the fill

    const materials = new Map();
    const materialFor = (hex) => {
        if (!materials.has(hex)) {
            const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: 0.6, metalness: 0 });
            m.name = hex;
            materials.set(hex, m);
        }
        return materials.get(hex);
    };
    const layers = new Map();   // colour hex → Group (one group per colour, hex-named)
    const layerFor = (hex) => {
        if (!layers.has(hex)) {
            const g = new THREE.Group();
            g.name = hex;
            layers.set(hex, g);
            group.add(g);
        }
        return layers.get(hex);
    };
    const addMesh = (geo, hex, name) => {
        if (!geo) return;
        const mesh = new THREE.Mesh(geo, materialFor(hex));
        mesh.name = name;
        layerFor(hex).add(mesh);
        stats.meshes++;
        stats.triangles += geo.attributes.position.count / 3;
    };

    // FILL — one mesh per SVG element, holes cut by containment.
    if (opts.fill !== false) {
        for (const shape of shapes) {
            const infos = shape.subpaths.filter((s) => s.vertices.length >= 3).map((sub) => ({ shape: { vertices: sub.vertices } }));
            const pieces = groupPathsWithHoles(infos).map((g) => triangulatePoly(g.shape.vertices, g.holes));
            const y0 = (shape.docIndex || 0) * gap;
            addMesh(extrudePieces(pieces, scale, y0, y0 + thickness), colorHex(shape.resolvedColor), shape.name);
        }
    }

    // OUTLINE — the band around every contour: one quad per edge plus corner
    // wedges at sharp tips (the pieces overlap on the inside; they are not
    // boolean-unioned). Coloured by the SVG stroke, else the fill.
    if (opts.outline) {
        const specs = outlineBoxSpecs(shapes, { width: opts.outlineWidth, align: opts.outlineAlign });
        const byShape = new Map();
        const piecesOf = (docIndex, color) => {
            if (!byShape.has(docIndex)) byShape.set(docIndex, { color, pieces: [] });
            return byShape.get(docIndex).pieces;
        };
        for (const sp of specs.boxes) {
            const px = -sp.uy, py = sp.ux, hl = sp.len / 2, hw = sp.width / 2;
            const c = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([u, v]) =>
                ({ x: sp.cx + sp.ux * hl * u + px * hw * v, y: sp.cy + sp.uy * hl * u + py * hw * v }));
            piecesOf(sp.docIndex, sp.color).push([[c[0], c[1], c[2]], [c[0], c[2], c[3]]]);
        }
        for (const tr of specs.tris) piecesOf(tr.docIndex, tr.color).push([[tr.a, tr.b, tr.c]]);
        for (const [docIndex, { color, pieces }] of byShape) {
            const y0 = (docIndex || 0) * gap;
            const shape = shapes.find((s) => s.docIndex === docIndex);
            addMesh(extrudePieces(pieces, scale, y0, y0 + thickness + lift), colorHex(color), `${shape ? shape.name : "shape"} outline`);
        }
    }

    // Orientation, baked into the vertices so every format gets the same thing.
    const m = new THREE.Matrix4();
    if (opts.upright) m.makeRotationX(Math.PI / 2);   // stand it up, front facing +Z
    const rotY = (parseFloat(opts.rotateY) || 0) * Math.PI / 180;
    if (rotY) m.premultiply(new THREE.Matrix4().makeRotationY(rotY));
    group.traverse((o) => { if (o.isMesh) o.geometry.applyMatrix4(m); });

    // Placement: optionally centred on the origin; the base always sits at
    // the elevation.
    const box = new THREE.Box3().setFromObject(group);
    if (!box.isEmpty()) {
        const shift = new THREE.Vector3(0, (parseFloat(opts.elevation) || 0) - box.min.y, 0);
        if (opts.center) {
            shift.x = -(box.min.x + box.max.x) / 2;
            shift.z = -(box.min.z + box.max.z) / 2;
        }
        const t = new THREE.Matrix4().makeTranslation(shift.x, shift.y, shift.z);
        group.traverse((o) => {
            if (!o.isMesh) return;
            o.geometry.applyMatrix4(t);
            o.geometry.computeBoundingBox();
            o.geometry.computeBoundingSphere();
        });
        const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
        stats.size = [size.x, size.y, size.z];
    }
    stats.layers = layers.size;
    return { group, stats };
}

/** Free a model's GPU resources (geometries and its materials). */
export function disposeModel(group) {
    const mats = new Set();
    if (group) group.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry.dispose();
        mats.add(o.material);
    });
    mats.forEach((m) => m.dispose());
}

/* =========================================================================
   Export
   ========================================================================= */
export function exportGLB(group) {
    return new Promise((resolve, reject) => {
        new GLTFExporter().parse(group,
            (buf) => resolve(new Blob([buf], { type: "model/gltf-binary" })),
            (err) => reject(err),
            { binary: true });
    });
}
export function exportOBJ(group) {
    return new Blob([new OBJExporter().parse(group)], { type: "model/obj" });
}
export function exportSTL(group) {
    return new Blob([new STLExporter().parse(group, { binary: true })], { type: "model/stl" });
}

/* =========================================================================
   Viewer — renders on demand, never in a loop.
   ========================================================================= */
export function createViewer(container) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);   // the viewport's own ground shows through
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1e6);
    camera.position.set(1, 1.2, 1.6);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(2, 4, 3);
    scene.add(sun);
    let grid = null;

    const controls = new OrbitControls(camera, renderer.domElement);
    let model = null, wire = false, homePos = null, homeTarget = null, homeRadius = 0;

    const render = () => {
        if (!container.clientWidth || !container.clientHeight) return;
        renderer.render(scene, camera);
    };
    controls.addEventListener("change", render);

    const resize = () => {
        const w = container.clientWidth, h = container.clientHeight;
        if (!w || !h) return;   // off stage: keep the last frame
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        render();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    function frame() {
        if (!model) return render();
        const box = new THREE.Box3().setFromObject(model);
        if (box.isEmpty()) return render();
        const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
        const r = Math.max(size.x, size.y, size.z, 1e-6);
        // Fit the narrower of the two fields of view (a phone is portrait).
        const vHalf = (camera.fov * Math.PI / 180) / 2;
        const hHalf = Math.atan(Math.tan(vHalf) * (camera.aspect || 1));
        const dist = r / Math.tan(Math.min(vHalf, hHalf));
        camera.near = r / 1000;
        camera.far = r * 1000;
        camera.updateProjectionMatrix();
        const dir = new THREE.Vector3(0.35, 0.75, 0.9).normalize();
        camera.position.copy(center).addScaledVector(dir, dist);
        controls.target.copy(center);
        controls.update();
        homePos = camera.position.clone();
        homeTarget = center.clone();

        if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
        const step = Math.pow(10, Math.floor(Math.log10(r)));
        const span = Math.ceil((r * 2) / step) * step;
        grid = new THREE.GridHelper(span, Math.max(2, Math.round(span / step) * 2), 0x3a4252, 0x252b36);
        grid.position.set(center.x, box.min.y, center.z);
        scene.add(grid);
        render();
    }

    return {
        setModel(group, { reframe = false } = {}) {
            if (model) { scene.remove(model); disposeModel(model); }
            model = group;
            if (model) {
                model.traverse((o) => { if (o.isMesh) o.material.wireframe = wire; });
                scene.add(model);
            }
            // Reframe on request, and whenever the model changed size a lot
            // (a new width, standing it up) — otherwise keep the user's view.
            let r = 0;
            if (model) { const bx = new THREE.Box3().setFromObject(model); if (!bx.isEmpty()) r = bx.getSize(new THREE.Vector3()).length(); }
            const jumped = !homeRadius || !r || r / homeRadius > 1.5 || r / homeRadius < 0.67;
            if (reframe || !homePos || jumped) { frame(); homeRadius = r; } else render();
        },
        setWireframe(on) {
            wire = !!on;
            if (model) model.traverse((o) => { if (o.isMesh) o.material.wireframe = wire; });
            render();
        },
        resetView() {
            if (!homePos) return frame();
            camera.position.copy(homePos);
            controls.target.copy(homeTarget);
            controls.update();
            render();
        },
        frame,
        resize,
        dispose() {
            ro.disconnect();
            controls.dispose();
            if (model) { scene.remove(model); disposeModel(model); model = null; }
            if (grid) { grid.geometry.dispose(); grid.material.dispose(); }
            renderer.dispose();
            renderer.domElement.remove();
        },
    };
}
