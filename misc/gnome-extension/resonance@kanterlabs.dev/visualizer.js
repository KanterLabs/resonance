import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

const BUILD = import.meta.url.match(/[?&]v=(\d+)/)?.[1] ?? '0';
const {DEFAULT_PALETTE} = await import(`./palette.js?v=${BUILD}`);
const {mix, roundedRect, smoothLine} = await import(`./draw.js?v=${BUILD}`);
const {Ridges} = await import(`./ridges.js?v=${BUILD}`);

export const MODES = ['orbit', 'bars', 'ridges', 'scope'];
export const MODE_LABELS = {orbit: 'Orbit', bars: 'Bars', ridges: 'Ridges', scope: 'Scope'};

// What the popup asks Resonance for. Sixty frames keeps up with the display;
// the drawing smooths between them anyway.
export const AUDIO_FEED = {fps: 60, bands: 64, waveform: 256};

const SCOPE_TRAILS = 5;
const CORNER = 18;

// Resonance reports each band on a decibel scale from its floor. Music sits in
// the middle of that range, so stretch it out and bend it to make quiet parts
// quiet and hits jump.
function shape(value) {
    const stretched = Math.min(1, Math.max(0, (value - 0.18) / 0.72));
    return stretched ** 1.35;
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
        this._ridges = new Ridges();
        // The full-screen view draws edge to edge.
        this.corner = CORNER;
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

    // What Resonance knows of the song's shape, for the Ridges skyline.
    setSongMap(map) {
        this._ridges.setSongMap(map);
    }

    // How far through the track playback is, 0 to 1, or null when unknown.
    setProgress(progress) {
        this._ridges.setProgress(progress);
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
        this._ridges.setTempo(audio.live ? audio.tempo : null);
        if (this._beats !== null && audio.beats > this._beats) {
            this._flash = 1;
            this._ridges.beat(Math.min(1, Math.max(0.5, audio.pulse * 1.4)), audio.beats);
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

        this._ridges.step(dt, this._view());
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

    // What the Ridges scene needs to know about the picture right now.
    _view() {
        return {
            shown: this._shown,
            palette: this._palette,
            flash: this._flash,
            level: this._level,
            live: this._live,
        };
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        try {
            this._drawCard(cr, w, h);
            cr.save();
            roundedRect(cr, 0, 0, w, h, this.corner);
            cr.clip();
            if (this.mode === 'bars')
                this._drawBars(cr, w, h);
            else if (this.mode === 'ridges')
                this._ridges.draw(cr, w, h, this._view());
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
        // Ridges paints its own sky and ground over the whole card, so a flat
        // fill will do, and is far cheaper than a gradient at full screen.
        if (this.mode === 'ridges') {
            roundedRect(cr, 0, 0, w, h, this.corner);
            cr.setSourceRGBA(...mix(dark, [0, 0, 0], 0.4), 1);
            cr.fill();
            return;
        }
        const glow = mix(dark, primary, 0.12 + 0.18 * this._flash + 0.1 * this._level);
        const gradient = new Cairo.RadialGradient(w / 2, h * 0.55, 0, w / 2, h * 0.55, Math.max(w, h) * 0.75);
        gradient.addColorStopRGBA(0, ...glow, 1);
        gradient.addColorStopRGBA(1, ...mix(dark, [0, 0, 0], 0.55), 1);
        roundedRect(cr, 0, 0, w, h, this.corner);
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
