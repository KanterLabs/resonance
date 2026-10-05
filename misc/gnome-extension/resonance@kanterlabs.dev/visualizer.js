import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

const BUILD = import.meta.url.match(/[?&]v=(\d+)/)?.[1] ?? '0';
const {DEFAULT_PALETTE} = await import(`./palette.js?v=${BUILD}`);

export const MODES = ['orbit', 'bars', 'ridges', 'scope'];
export const MODE_LABELS = {orbit: 'Orbit', bars: 'Bars', ridges: 'Ridges', scope: 'Scope'};

// What the popup asks Resonance for. Sixty frames keeps up with the display;
// the drawing smooths between them anyway.
export const AUDIO_FEED = {fps: 60, bands: 64, waveform: 256};

const RIDGE_ROWS = 32;
const RIDGE_POINTS = 64;
const RIDGE_SECONDS = 1 / 18;
// How quickly ridges shrink with distance. A ridge `d` rows back is drawn at
// 1 / (1 + d * RIDGE_DEPTH) of its size, which is what perspective does.
const RIDGE_DEPTH = 0.16;
const SCOPE_TRAILS = 5;
const CORNER = 18;

// Resonance reports each band on a decibel scale from its floor. Music sits in
// the middle of that range, so stretch it out and bend it to make quiet parts
// quiet and hits jump.
function shape(value) {
    const stretched = Math.min(1, Math.max(0, (value - 0.18) / 0.72));
    return stretched ** 1.35;
}

function mix(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function roundedRect(cr, x, y, w, h, r) {
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

// A smooth curve through points, as Catmull-Rom segments turned into Béziers.
function smoothLine(cr, points, moveFirst = true) {
    if (points.length < 2)
        return;
    if (moveFirst)
        cr.moveTo(points[0][0], points[0][1]);
    else
        cr.lineTo(points[0][0], points[0][1]);
    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[Math.max(0, i - 1)];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[Math.min(points.length - 1, i + 2)];
        cr.curveTo(
            p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
            p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
            p2[0], p2[1]);
    }
}

// The card the visualizers draw on. It owns the motion: audio frames set
// targets, and every display frame eases what is drawn towards them, so the
// picture stays smooth between frames and falls gracefully when sound stops.
// GObject type names last for the whole shell session, so each reload of this
// module registers under its own build's name rather than clashing with the last.
export const Visualizer = GObject.registerClass({
    GTypeName: `ResonanceVisualizer_${BUILD}`,
}, class Visualizer extends St.DrawingArea {
    _init(params) {
        super._init({...params, style_class: 'rz-visualizer'});
        this.mode = 'orbit';
        this._palette = DEFAULT_PALETTE;
        this._target = new Float32Array(AUDIO_FEED.bands);
        this._shown = new Float32Array(AUDIO_FEED.bands);
        this._peaks = new Float32Array(AUDIO_FEED.bands);
        this._fall = new Float32Array(AUDIO_FEED.bands);
        this._waveform = [];
        this._trails = [];
        // Each ridge is {values, palette, beat}: the spectrum when it was taken,
        // the colours of the song playing then, and how hard a beat hit during it.
        this._ridges = [];
        this._ridgeClock = 0;
        this._ridgeBeat = 0;
        this._level = 0;
        this._pulse = 0;
        this._flash = 0;
        this._beats = null;
        this._spin = 0;
        this._live = false;
        this._playing = false;
        this._time = 0;

        this._timeline = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._step());
        this.connect('destroy', () => this._timeline.stop());

        // The cover spins at the centre of the orbit like a record.
        this.disc = new St.Widget({style_class: 'rz-disc', visible: false});
        this.disc.set_pivot_point(0.5, 0.5);
    }

    setPalette(palette) {
        this._palette = palette;
        this.queue_repaint();
    }

    setMode(mode) {
        this.mode = MODES.includes(mode) ? mode : 'orbit';
        this.disc.visible = this.mode === 'orbit';
        this.queue_repaint();
    }

    setPlaying(playing) {
        this._playing = playing;
    }

    // One frame of Resonance's audio feed.
    feed(audio) {
        this._live = audio.live;
        const bands = audio.bands ?? [];
        for (let i = 0; i < this._target.length; i++)
            this._target[i] = audio.live ? shape(bands[i] ?? 0) : 0;
        this._waveform = audio.live ? audio.waveform ?? [] : [];
        this._level = audio.live ? audio.level : 0;
        this._pulse = audio.live ? audio.pulse : 0;
        if (this._beats !== null && audio.beats > this._beats) {
            this._flash = 1;
            // Remembered until the next ridge is taken, which carries it away.
            this._ridgeBeat = Math.max(this._ridgeBeat, Math.min(1, Math.max(0.5, audio.pulse * 1.4)));
        }
        this._beats = audio.beats;
    }

    start() {
        this._last = GLib.get_monotonic_time();
        this._timeline.start();
    }

    stop() {
        this._timeline.stop();
    }

    _step() {
        const now = GLib.get_monotonic_time();
        const dt = Math.min(0.1, (now - (this._last ?? now)) / 1e6);
        this._last = now;
        this._time += dt;

        // Quick to rise, slower to fall, so hits land and tails linger.
        const rise = 1 - Math.exp(-dt * 28);
        const settle = 1 - Math.exp(-dt * 7);
        for (let i = 0; i < this._shown.length; i++) {
            const target = this._target[i];
            this._shown[i] += (target - this._shown[i]) * (target > this._shown[i] ? rise : settle);
            if (this._shown[i] >= this._peaks[i]) {
                this._peaks[i] = this._shown[i];
                this._fall[i] = 0;
            } else {
                this._fall[i] += dt * 2.2;
                this._peaks[i] = Math.max(0, this._peaks[i] - this._fall[i] * dt);
            }
        }
        if (!this._live)
            this._target.fill(0);
        this._flash *= Math.exp(-dt * 5);
        this._pulse *= Math.exp(-dt * 4);

        this._ridgeClock += dt;
        while (this._ridgeClock >= RIDGE_SECONDS) {
            this._ridgeClock -= RIDGE_SECONDS;
            this._ridges.unshift({values: this._ridgeRow(), palette: this._palette, beat: this._ridgeBeat});
            this._ridgeBeat = 0;
            this._ridges.length = Math.min(this._ridges.length, RIDGE_ROWS);
        }
        if (this._waveform.length) {
            this._trails.unshift(this._waveform);
            this._trails.length = Math.min(this._trails.length, SCOPE_TRAILS);
        } else if (this._trails.length) {
            this._trails.pop();
        }

        if (this.disc.visible) {
            this._spin = (this._spin + dt * (this._playing ? 24 : 0)) % 360;
            const scale = 1 + 0.07 * this._pulse + 0.03 * this._flash;
            this.disc.rotation_angle_z = this._spin;
            this.disc.set_scale(scale, scale);
        }
        this.queue_repaint();
    }

    // The spectrum folded into a mountain, bass in the middle and treble at
    // the edges, tapered so every ridge meets the ground.
    _ridgeRow() {
        const row = new Float32Array(RIDGE_POINTS);
        const bands = this._shown.length;
        for (let i = 0; i < RIDGE_POINTS; i++) {
            const fromCentre = Math.abs(i - (RIDGE_POINTS - 1) / 2) / ((RIDGE_POINTS - 1) / 2);
            const band = Math.min(bands - 1, Math.floor(fromCentre * bands * 0.8));
            const taper = Math.cos(fromCentre * Math.PI / 2) ** 1.6;
            row[i] = this._shown[band] * taper;
        }
        return row;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        try {
            this._drawCard(cr, w, h);
            cr.save();
            roundedRect(cr, 0, 0, w, h, CORNER);
            cr.clip();
            if (this.mode === 'bars')
                this._drawBars(cr, w, h);
            else if (this.mode === 'ridges')
                this._drawRidges(cr, w, h);
            else if (this.mode === 'scope')
                this._drawScope(cr, w, h);
            else
                this._drawOrbit(cr, w, h);
            cr.restore();
        } finally {
            cr.$dispose();
        }
    }

    _drawCard(cr, w, h) {
        const {dark, primary} = this._palette;
        const glow = mix(dark, primary, 0.12 + 0.18 * this._flash + 0.1 * this._level);
        const gradient = new Cairo.RadialGradient(w / 2, h * 0.55, 0, w / 2, h * 0.55, Math.max(w, h) * 0.75);
        gradient.addColorStopRGBA(0, ...glow, 1);
        gradient.addColorStopRGBA(1, ...mix(dark, [0, 0, 0], 0.55), 1);
        roundedRect(cr, 0, 0, w, h, CORNER);
        cr.setSource(gradient);
        cr.fill();
    }

    _colorAt(t) {
        return mix(this._palette.primary, this._palette.secondary, t);
    }

    _drawOrbit(cr, w, h) {
        const cx = w / 2;
        const cy = h / 2;
        const inner = Math.min(w, h) * 0.24 * (1 + 0.07 * this._pulse + 0.03 * this._flash);
        const reach = Math.min(w, h) * 0.24;
        const bands = this._shown.length;

        // A halo that swells with loudness.
        const halo = new Cairo.RadialGradient(cx, cy, inner * 0.8, cx, cy, inner + reach * 1.4);
        halo.addColorStopRGBA(0, ...this._palette.primary, 0.35 * this._level + 0.25 * this._flash);
        halo.addColorStopRGBA(1, ...this._palette.primary, 0);
        cr.setSource(halo);
        cr.paint();

        cr.setOperator(Cairo.Operator.ADD);
        cr.setLineCap(Cairo.LineCap.ROUND);
        // Each band twice, mirrored left and right, bass at the top.
        const spokes = bands * 2;
        const width = Math.max(2, (2 * Math.PI * inner / spokes) * 0.55);
        for (let s = 0; s < spokes; s++) {
            const band = s < bands ? s : spokes - 1 - s;
            const value = this._shown[band];
            const angle = -Math.PI / 2 + (s + 0.5) / spokes * 2 * Math.PI;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            const from = inner + 6;
            const to = from + 2 + value * reach;
            const color = this._colorAt(band / (bands - 1));
            cr.setLineWidth(width * 2.6);
            cr.setSourceRGBA(...color, 0.12 + 0.2 * value);
            cr.moveTo(cx + cos * from, cy + sin * from);
            cr.lineTo(cx + cos * to, cy + sin * to);
            cr.stroke();
            cr.setLineWidth(width);
            cr.setSourceRGBA(...mix(color, [1, 1, 1], 0.2 * value), 0.55 + 0.45 * value);
            cr.moveTo(cx + cos * from, cy + sin * from);
            cr.lineTo(cx + cos * to, cy + sin * to);
            cr.stroke();
            // Peaks orbit outside as dots.
            const peak = from + 6 + this._peaks[band] * reach;
            cr.setSourceRGBA(...color, 0.5 * this._peaks[band]);
            cr.arc(cx + cos * peak, cy + sin * peak, width * 0.55, 0, 2 * Math.PI);
            cr.fill();
        }

        // A ring that flares on each beat.
        cr.setLineWidth(2 + 5 * this._flash);
        cr.setSourceRGBA(...mix(this._palette.secondary, [1, 1, 1], 0.4), 0.25 + 0.6 * this._flash);
        cr.arc(cx, cy, inner + 1, 0, 2 * Math.PI);
        cr.stroke();
        cr.setOperator(Cairo.Operator.OVER);
    }

    _drawBars(cr, w, h) {
        const bands = this._shown.length;
        const pad = 18;
        const gap = 3;
        const barWidth = (w - pad * 2 - gap * (bands - 1)) / bands;
        const base = h * 0.68;
        const tall = base - 16;

        cr.setOperator(Cairo.Operator.ADD);
        for (let i = 0; i < bands; i++) {
            const value = this._shown[i];
            const x = pad + i * (barWidth + gap);
            const height = 3 + value * tall;
            const color = this._colorAt(i / (bands - 1));
            const bright = mix(color, [1, 1, 1], 0.35 * value + 0.25 * this._flash);

            const fill = new Cairo.LinearGradient(0, base - height, 0, base);
            fill.addColorStopRGBA(0, ...bright, 0.95);
            fill.addColorStopRGBA(1, ...color, 0.55);
            roundedRect(cr, x, base - height, barWidth, height, Math.min(barWidth / 2, 3));
            cr.setSource(fill);
            cr.fill();

            // The reflection on the floor below.
            const mirror = new Cairo.LinearGradient(0, base + 4, 0, base + 4 + height * 0.45);
            mirror.addColorStopRGBA(0, ...color, 0.28);
            mirror.addColorStopRGBA(1, ...color, 0);
            cr.rectangle(x, base + 4, barWidth, height * 0.45);
            cr.setSource(mirror);
            cr.fill();

            // A cap that hangs at the peak and drops.
            const peakY = base - 3 - this._peaks[i] * tall - 4;
            cr.setSourceRGBA(...mix(color, [1, 1, 1], 0.6), 0.9 * Math.min(1, this._peaks[i] * 3));
            cr.rectangle(x, peakY, barWidth, 2);
            cr.fill();
        }
        cr.setOperator(Cairo.Operator.OVER);
    }

    _drawRidges(cr, w, h) {
        const horizon = h * 0.27;
        const ground = h - 16;
        const lift = h * 0.36;
        // Wider than the card at the front, so the nearest ridges run off its edges.
        const span = w * 1.12;
        const glow = this._palette.secondary;

        // A sky that brightens towards the horizon, and the horizon itself.
        const sky = new Cairo.LinearGradient(0, 0, 0, horizon + 4);
        sky.addColorStopRGBA(0, ...glow, 0);
        sky.addColorStopRGBA(1, ...glow, 0.16 + 0.22 * this._level + 0.18 * this._flash);
        cr.rectangle(0, 0, w, horizon + 4);
        cr.setSource(sky);
        cr.fill();
        const line = new Cairo.LinearGradient(0, 0, w, 0);
        line.addColorStopRGBA(0, ...glow, 0);
        line.addColorStopRGBA(0.5, ...mix(glow, [1, 1, 1], 0.4), 0.55 + 0.35 * this._flash);
        line.addColorStopRGBA(1, ...glow, 0);
        // The plain the ridges stand on, hazing into the horizon, so the
        // furthest ones sit on ground that runs out to it rather than floating.
        const earth = (palette, fog) => mix(mix(palette.dark, [0, 0, 0], 0.45), glow, fog * 0.16);
        const plain = new Cairo.LinearGradient(0, horizon, 0, ground);
        plain.addColorStopRGBA(0, ...earth(this._palette, 1), 1);
        plain.addColorStopRGBA(0.35, ...earth(this._palette, 0.15), 1);
        plain.addColorStopRGBA(1, ...earth(this._palette, 0), 1);
        cr.rectangle(0, horizon, w, h - horizon);
        cr.setSource(plain);
        cr.fill();
        cr.rectangle(0, horizon - 0.75, w, 1.5);
        cr.setSource(line);
        cr.fill();

        // Ridges slide back continuously between the moments they are taken.
        // The live one at the front follows the music every frame; each one
        // taken starts out identical to it and then peels away behind.
        const phase = this._ridgeClock / RIDGE_SECONDS;
        const live = {values: this._ridgeRow(), palette: this._palette, beat: this._flash};
        const ridges = [live, ...this._ridges];
        for (let r = ridges.length - 1; r >= 0; r--) {
            const ridge = ridges[r];
            const depth = r === 0 ? 0 : r - 1 + phase;
            const scale = 1 / (1 + depth * RIDGE_DEPTH);
            // 0 at the front to 1 at the back, for fading into the distance.
            const fog = Math.min(1, depth / RIDGE_ROWS);
            // The last ridge fades out rather than vanishing as it drops off.
            const fade = Math.min(1, RIDGE_ROWS - depth);
            if (fade <= 0)
                continue;
            const base = horizon + (ground - horizon) * scale;
            const width = span * scale;
            const left = (w - width) / 2;
            const values = ridge.values;
            const points = [];
            for (let i = 0; i < values.length; i++)
                points.push([left + i / (values.length - 1) * width, base - values[i] * lift * scale]);

            // Filled down to the floor so it hides the ridges behind it, in its
            // song's darkest colour hazed towards the horizon.
            smoothLine(cr, points);
            cr.lineTo(left + width, h);
            cr.lineTo(left, h);
            cr.closePath();
            cr.setSourceRGBA(...earth(ridge.palette, fog), fade);
            cr.fill();

            const color = mix(mix(ridge.palette.primary, ridge.palette.secondary, fog), [1, 1, 1], ridge.beat * 0.55);
            const alpha = Math.min(1, 0.95 - fog * 0.6 + ridge.beat * 0.3) * fade;
            if (ridge.beat > 0.05) {
                // A beat ridge glows, so the rhythm marches off as bright stripes.
                cr.setOperator(Cairo.Operator.ADD);
                smoothLine(cr, points);
                cr.setLineWidth((4 + 8 * ridge.beat) * scale);
                cr.setSourceRGBA(...color, 0.16 * ridge.beat * fade);
                cr.stroke();
                cr.setOperator(Cairo.Operator.OVER);
            }
            smoothLine(cr, points);
            cr.setLineWidth((r === 0 ? 2.2 : 1.1) * (0.5 + 0.5 * scale) + ridge.beat * 1.4 * scale);
            cr.setSourceRGBA(...color, alpha);
            cr.stroke();
        }
    }

    _drawScope(cr, w, h) {
        const cy = h / 2;
        const amplitude = h * 0.4;
        const pad = 14;

        // A faint centre line, like the graticule on a real scope.
        cr.setSourceRGBA(1, 1, 1, 0.06);
        cr.setLineWidth(1);
        cr.moveTo(pad, cy);
        cr.lineTo(w - pad, cy);
        cr.stroke();

        cr.setOperator(Cairo.Operator.ADD);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        for (let t = this._trails.length - 1; t >= 0; t--) {
            const wave = this._steady(this._trails[t]);
            if (wave.length < 2)
                continue;
            const points = wave.map((sample, i) =>
                [pad + i / (wave.length - 1) * (w - pad * 2), cy - sample * amplitude]);
            const fade = 1 - t / SCOPE_TRAILS;
            const color = this._colorAt(t / SCOPE_TRAILS);
            // Wide and faint, then narrow and bright: a phosphor glow.
            smoothLine(cr, points);
            cr.setLineWidth(10 + 8 * this._flash);
            cr.setSourceRGBA(...color, 0.07 * fade);
            cr.stroke();
            smoothLine(cr, points);
            cr.setLineWidth(t === 0 ? 2.4 : 1.4);
            cr.setSourceRGBA(...mix(color, [1, 1, 1], t === 0 ? 0.35 : 0), 0.85 * fade);
            cr.stroke();
        }
        cr.setOperator(Cairo.Operator.OVER);
    }

    // The window starting at its first upward zero crossing, so the wave holds
    // still on screen instead of sliding about from frame to frame.
    _steady(wave) {
        const half = Math.floor(wave.length / 2);
        let start = 0;
        for (let i = 1; i < half; i++) {
            if (wave[i - 1] < 0 && wave[i] >= 0) {
                start = i;
                break;
            }
        }
        return wave.slice(start, start + half);
    }

});
