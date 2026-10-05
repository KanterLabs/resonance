import Cairo from 'cairo';

const BUILD = import.meta.url.match(/[?&]v=(\d+)/)?.[1] ?? '0';
const {mix, smoothLine} = await import(`./draw.js?v=${BUILD}`);

const ROWS = 32;
const POINTS = 64;
// How often a ridge is taken when the tempo is unknown. With a tempo, the
// nearest interval that divides a beat evenly is used, so beats land on ridges
// at an even spacing and the stripes march off in time.
const INTERVAL = 1 / 18;
// How quickly ridges shrink with distance. A ridge `d` rows back is drawn at
// 1 / (1 + d * DEPTH) of its size, which is what perspective does.
const DEPTH = 0.16;
const STARS = 90;
// The sun's halo is drawn once into an image this size and scaled up, since a
// radial gradient computed per pixel is slow on a full-screen canvas.
const HALO_SIZE = 128;
// How much each kind of beat lights its ridge: an ordinary beat, the first
// beat of a bar, of a four-bar phrase, and of a sixteen-bar section.
const ACCENTS = [0.45, 0.8, 1, 1];

// Bass is the first few bands and treble the top quarter, out of the 64.
const BASS = [0, 8];
const TREBLE = [40, 64];

function average(values, [from, to]) {
    let sum = 0;
    for (let i = from; i < to; i++)
        sum += values[i];
    return sum / (to - from);
}

// The same sky every time, from a small seeded generator.
function makeStars() {
    let seed = 7;
    const random = () => (seed = seed * 16807 % 2147483647) / 2147483647;
    return Array.from({length: STARS}, () => ({
        x: random(),
        // Fewer near the horizon, where the glow would wash them out.
        y: random() ** 1.3,
        size: 0.5 + random() * 1.1,
        phase: random() * Math.PI * 2,
        speed: 1.5 + random() * 4,
        // Each star twinkles with its own slice of the treble.
        band: TREBLE[0] + Math.floor(random() * (TREBLE[1] - TREBLE[0])),
    }));
}

// The Ridges scene: a landscape of spectra running back to a horizon, under a
// sky with the cover setting as its sun.
//
// It also listens for the shape of the song. A breakdown (bass falling well
// below its recent average) flattens the land, thickens the fog and brings the
// stars out; the drop that follows surges the land back up and flashes the
// horizon. Pausing counts as the quietest breakdown, so resuming is a drop.
export class Ridges {
    constructor() {
        // Each ridge is {values, palette, beat, accent}: the spectrum when it was
        // taken, the colours of the song playing then, how hard a beat hit during
        // it, and which kind of beat that was (see ACCENTS).
        this._rows = [];
        this._clock = 0;
        this._interval = INTERVAL;
        this._beat = 0;
        this._accent = 0;
        // Which of every four beats is the downbeat, learned from which hits
        // hardest, and the downbeat that phrases are counted from.
        this._barSlots = [0, 0, 0, 0];
        this._phraseOrigin = null;
        this._tempo = null;
        // What is known of the song's shape, and how far through it we are.
        this._map = null;
        this._progress = null;
        this._time = 0;
        // Starting calm means opening the popup is itself a drop.
        this._calm = 1;
        this._calmMemory = 1;
        this._surge = 0;
        this._fast = 0;
        this._slow = 0;
        this._stars = makeStars();
        this._meteors = [];
        this._sinceMeteor = 0;
        this._sunPath = null;
        this._sun = null;
        this._sunScroll = 0;
        this._halo = null;
        this._haloColor = null;
    }

    setTempo(tempo) {
        this._tempo = tempo || null;
    }

    // The song's map from Resonance: {uri, level, bass, mid, treble}, each lane
    // an array of 0 to 1 with nulls where unheard.
    setSongMap(map) {
        if (map?.uri !== this._map?.uri)
            this._phraseOrigin = null;
        this._map = map?.level ? map : null;
        if (this._map) {
            // The song's own quietest and loudest stretches, so every skyline
            // uses its full height whatever the mastering.
            const heard = this._map.level.filter(value => value !== null);
            this._mapLow = heard.length ? Math.min(...heard) : 0;
            this._mapHigh = heard.length ? Math.max(...heard) : 1;
        }
    }

    // How far through the track playback is, 0 to 1, or null when unknown.
    setProgress(progress) {
        this._progress = progress;
    }

    // Beat number `count` landed, `strength` from 0.5 to 1.
    beat(strength, count) {
        const slot = count % 4;
        for (let i = 0; i < 4; i++)
            this._barSlots[i] *= 0.92;
        // Downbeats tend to carry the kick, so bass at the moment counts too.
        this._barSlots[slot] += strength + this._fast;
        const downbeat = this._barSlots.indexOf(Math.max(...this._barSlots));
        let accent = 0;
        if (slot === downbeat) {
            // Phrases count from the song's first downbeat, and again from each
            // drop, which is where sections tend to begin.
            if (this._phraseOrigin === null || (count - this._phraseOrigin) % 4 !== 0)
                this._phraseOrigin = count;
            const bars = (count - this._phraseOrigin) / 4;
            accent = bars % 16 === 0 ? 3 : bars % 4 === 0 ? 2 : 1;
        }
        // Remembered until the next ridge is taken, which carries it away.
        this._beat = Math.max(this._beat, strength * ACCENTS[accent]);
        this._accent = Math.max(this._accent, accent);
        if (strength > 0.85 && this._sinceMeteor > 5 && Math.random() < 0.4)
            this._launchMeteor();
    }

    // Move on by `dt` seconds. `view` is what the visualizer currently shows:
    // {shown, palette, flash, level, live}.
    step(dt, view) {
        this._time += dt;
        this._listen(dt, view);

        this._clock += dt;
        while (this._clock >= this._interval) {
            this._clock -= this._interval;
            this._rows.unshift({
                values: this._values(view.shown),
                palette: view.palette,
                beat: this._beat,
                accent: this._accent,
            });
            this._beat = 0;
            this._accent = 0;
            this._rows.length = Math.min(this._rows.length, ROWS);
            // Changed only as a ridge is taken, so the scroll never jumps.
            this._interval = this._nextInterval();
        }

        this._sinceMeteor += dt;
        if (this._calm > 0.6 && Math.random() < dt * 0.08)
            this._launchMeteor();
        for (const meteor of this._meteors)
            meteor.life += dt;
        this._meteors = this._meteors.filter(meteor => meteor.life < meteor.duration);

        this._sunScroll = (this._sunScroll + dt * (0.25 + 0.6 * this._surge)) % 1;
    }

    _nextInterval() {
        if (!this._tempo)
            return INTERVAL;
        const beat = 60 / this._tempo;
        return beat / Math.max(1, Math.round(beat / INTERVAL));
    }

    // Follow the bass against its own recent average to tell a breakdown from
    // a drop, independent of how loud the song is overall.
    _listen(dt, view) {
        const bass = average(view.shown, BASS);
        this._fast += (bass - this._fast) * (1 - Math.exp(-dt / 0.25));
        this._slow += (bass - this._slow) * (1 - Math.exp(-dt / 6));
        const quiet = !view.live || this._fast < this._slow * 0.55;
        this._calm += ((quiet ? 1 : 0) - this._calm) * (1 - Math.exp(-dt / (quiet ? 1.4 : 0.4)));
        // A drop has to follow a breakdown, but not straight away.
        this._calmMemory = Math.max(this._calm, this._calmMemory - dt * 0.12);
        if (view.live && this._calmMemory > 0.5 && this._fast > this._slow * 1.15 + 0.06) {
            this._surge = 1;
            this._calmMemory = 0;
            this._phraseOrigin = null;
        }
        this._surge *= Math.exp(-dt * 1.4);
    }

    // The spectrum folded into a mountain, bass in the middle and treble at
    // the edges, tapered so every ridge meets the ground, and raised or
    // flattened by the mood of the song.
    _values(shown) {
        const terrain = (1 - 0.6 * this._calm) * (1 + 0.45 * this._surge);
        const row = new Float32Array(POINTS);
        for (let i = 0; i < POINTS; i++) {
            const fromCentre = Math.abs(i - (POINTS - 1) / 2) / ((POINTS - 1) / 2);
            const band = Math.min(shown.length - 1, Math.floor(fromCentre * shown.length * 0.8));
            const taper = Math.cos(fromCentre * Math.PI / 2) ** 1.6;
            row[i] = shown[band] * taper * terrain;
        }
        return row;
    }

    _launchMeteor() {
        this._sinceMeteor = 0;
        this._meteors.push({
            x: 0.1 + 0.6 * Math.random(),
            y: 0.05 + 0.3 * Math.random(),
            vx: 0.55 + 0.3 * Math.random(),
            vy: 0.25,
            life: 0,
            duration: 0.9,
        });
    }

    draw(cr, w, h, view) {
        const horizon = h * 0.27;
        const ground = h - 16;
        const glow = view.palette.secondary;
        // The popup draws at 280px tall; bigger canvases scale details up.
        const unit = Math.max(1, h / 280);

        this._drawSky(cr, w, horizon, view, glow, unit);
        this._drawSun(cr, w, horizon, view, glow);
        this._drawSkyline(cr, w, horizon, view, glow, unit);

        // The plain the ridges stand on, hazing into the horizon, so the
        // furthest ones sit on ground that runs out to it rather than floating.
        const earth = (palette, fog) => mix(mix(palette.dark, [0, 0, 0], 0.45), glow, fog * 0.16);
        const plain = new Cairo.LinearGradient(0, horizon, 0, ground);
        plain.addColorStopRGBA(0, ...earth(view.palette, 1), 1);
        plain.addColorStopRGBA(0.35, ...earth(view.palette, 0.15), 1);
        plain.addColorStopRGBA(1, ...earth(view.palette, 0), 1);
        cr.rectangle(0, horizon, w, h - horizon);
        cr.setSource(plain);
        cr.fill();

        const line = new Cairo.LinearGradient(0, 0, w, 0);
        line.addColorStopRGBA(0, ...glow, 0);
        line.addColorStopRGBA(0.5, ...mix(glow, [1, 1, 1], 0.4 + 0.4 * this._surge),
            Math.min(1, 0.55 + 0.35 * view.flash + 0.4 * this._surge));
        line.addColorStopRGBA(1, ...glow, 0);
        cr.rectangle(0, horizon - 0.75 * unit, w, 1.5 * unit);
        cr.setSource(line);
        cr.fill();

        this._drawLand(cr, w, h, horizon, ground, view, earth, unit);
    }

    _drawSky(cr, w, horizon, view, glow, unit) {
        // Brightening towards the horizon, and flashing with a drop.
        const sky = new Cairo.LinearGradient(0, 0, 0, horizon + 4);
        sky.addColorStopRGBA(0, ...glow, 0);
        sky.addColorStopRGBA(1, ...glow, Math.min(1, 0.16 + 0.22 * view.level + 0.18 * view.flash + 0.45 * this._surge));
        cr.rectangle(0, 0, w, horizon + 4);
        cr.setSource(sky);
        cr.fill();

        // Stars, faint while the music is busy and out in force in a breakdown.
        const visible = 0.22 + 0.78 * this._calm;
        for (const star of this._stars) {
            const y = star.y * (horizon - 6);
            const twinkle = 0.5 + 0.5 * Math.sin(this._time * star.speed + star.phase);
            const near = 1 - (y / horizon) ** 3;
            const alpha = Math.min(1, visible * (0.25 + 0.75 * twinkle) * (0.45 + 0.9 * view.shown[star.band]) * near);
            if (alpha < 0.03)
                continue;
            const x = star.x * w;
            const radius = star.size * Math.sqrt(unit);
            if (alpha > 0.6) {
                cr.setSourceRGBA(...mix(glow, [1, 1, 1], 0.6), alpha * 0.18);
                cr.arc(x, y, radius * 3, 0, 2 * Math.PI);
                cr.fill();
            }
            cr.setSourceRGBA(1, 1, 1, alpha);
            cr.arc(x, y, radius, 0, 2 * Math.PI);
            cr.fill();
        }

        // Shooting stars, on a big beat or now and then in a quiet patch.
        cr.setLineCap(Cairo.LineCap.ROUND);
        for (const meteor of this._meteors) {
            const fade = Math.sin(Math.PI * meteor.life / meteor.duration);
            const x = (meteor.x + meteor.vx * meteor.life) * w;
            const y = (meteor.y + meteor.vy * meteor.life) * horizon;
            const length = 0.12 * w;
            const norm = Math.hypot(meteor.vx * w, meteor.vy * horizon);
            const tx = x - meteor.vx * w / norm * length;
            const ty = y - meteor.vy * horizon / norm * length;
            const tail = new Cairo.LinearGradient(tx, ty, x, y);
            tail.addColorStopRGBA(0, 1, 1, 1, 0);
            tail.addColorStopRGBA(1, 1, 1, 1, 0.9 * fade);
            cr.moveTo(tx, ty);
            cr.lineTo(x, y);
            cr.setSource(tail);
            cr.setLineWidth(1.6 * unit);
            cr.stroke();
        }
    }

    // The cover as a sun half set behind the horizon, swelling with the bass,
    // its lower half cut into slices that slide down into the land.
    _drawSun(cr, w, horizon, view, glow) {
        if (view.palette.sun !== this._sunPath) {
            this._sunPath = view.palette.sun ?? null;
            this._sun = null;
            try {
                if (this._sunPath)
                    this._sun = Cairo.ImageSurface.createFromPNG(this._sunPath);
            } catch (e) {
                console.warn(`Resonance: sun ${this._sunPath}: ${e.message}`);
            }
        }

        const radius = horizon * 0.62 * (1 + 0.1 * this._fast + 0.05 * view.flash);
        const cx = w / 2;
        // The sun sets with the song: high at the start, gone by the end,
        // lingering near the top for most of it.
        const setting = this._progress === null ? 0.5 : this._progress ** 1.6;
        const cy = horizon + radius * (-0.85 + 1.9 * setting);

        const reach = radius * 2.4;
        cr.save();
        cr.rectangle(0, 0, w, horizon);
        cr.clip();
        cr.translate(cx - reach, cy - reach);
        cr.scale(reach / HALO_SIZE, reach / HALO_SIZE);
        cr.setSourceSurface(this._haloFor(glow), 0, 0);
        cr.paintWithAlpha(Math.min(1, 0.3 + 0.25 * this._fast + 0.25 * this._surge));
        cr.restore();

        // The slices are cut out of a group, kept to the sun's own square so
        // a full-screen canvas does not pay for a full-screen group.
        cr.save();
        cr.rectangle(cx - radius, cy - radius, 2 * radius, 2 * radius);
        cr.clip();
        cr.pushGroup();
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.clip();
        if (this._sun) {
            cr.save();
            cr.translate(cx - radius, cy - radius);
            cr.scale(2 * radius / this._sun.getWidth(), 2 * radius / this._sun.getHeight());
            cr.setSourceSurface(this._sun, 0, 0);
            cr.paint();
            cr.restore();
        }
        // Tinted into the sky's colours so any cover sits in the scene.
        const tint = new Cairo.LinearGradient(0, cy - radius, 0, cy + radius);
        tint.addColorStopRGBA(0, ...view.palette.primary, this._sun ? 0.08 : 1);
        tint.addColorStopRGBA(1, ...glow, this._sun ? 0.4 : 1);
        cr.setSource(tint);
        cr.paint();
        cr.setOperator(Cairo.Operator.DEST_OUT);
        // Above the horizon, widening as they sink towards it.
        for (let k = 0; k < 5; k++) {
            const t = (k + this._sunScroll) / 5;
            const top = cy - radius * 0.62 + t * radius * 0.62;
            cr.rectangle(cx - radius, top, 2 * radius, radius * (0.025 + 0.1 * t));
        }
        cr.fill();
        cr.popGroupToSource();
        cr.paint();
        cr.restore();
    }

    // The whole song as a mountain range on the horizon, its height the song's
    // loudness from its own quietest to loudest, with a light where playback is.
    // The part already played stands out; the rest waits, dimmer. Stretches not
    // heard yet lie flat, so a first listen draws the range in as it goes.
    _drawSkyline(cr, w, horizon, view, glow, unit) {
        const map = this._map;
        if (!map)
            return;
        const left = w * 0.06;
        const width = w - left * 2;
        const tall = horizon * 0.34;
        const range = Math.max(0.05, this._mapHigh - this._mapLow);
        const count = map.level.length;
        const points = map.level.map((value, i) => {
            const height = value === null ? 0.02 : 0.08 + 0.92 * ((value - this._mapLow) / range) ** 1.3;
            return [left + (i + 0.5) / count * width, horizon - height * tall];
        });
        const outline = () => {
            cr.moveTo(left, horizon);
            smoothLine(cr, points, false);
            cr.lineTo(left + width, horizon);
        };
        const at = this._progress === null ? null : left + this._progress * width;

        // Played and still to come, drawn alike but lit differently.
        for (const played of [true, false]) {
            cr.save();
            if (at !== null) {
                cr.rectangle(played ? 0 : at, 0, played ? at : w - at, horizon + 1);
                cr.clip();
            } else if (!played) {
                cr.restore();
                continue;
            }
            outline();
            cr.closePath();
            // Played ground is lit by the sun; what is to come stands in silhouette.
            if (played)
                cr.setSourceRGBA(...mix(glow, [1, 1, 1], 0.2), 0.5);
            else
                cr.setSourceRGBA(...mix(view.palette.dark, glow, 0.15), 0.9);
            cr.fill();
            outline();
            cr.setLineWidth(1.2 * unit);
            cr.setSourceRGBA(...mix(glow, [1, 1, 1], played ? 0.45 : 0.1), played ? 0.85 : 0.35);
            cr.stroke();
            cr.restore();
        }

        if (at === null)
            return;
        // The skyline's height where playback is, for the marker to stand on.
        const index = Math.min(count - 1, Math.floor(this._progress * count));
        const peak = points[index][1];
        cr.setSourceRGBA(1, 1, 1, 0.5);
        cr.rectangle(at - 0.5 * unit, peak, unit, horizon - peak);
        cr.fill();
        cr.setSourceRGBA(...mix(glow, [1, 1, 1], 0.5), 0.35 + 0.4 * view.flash);
        cr.arc(at, peak, (4 + 3 * view.flash) * unit, 0, 2 * Math.PI);
        cr.fill();
        cr.setSourceRGBA(1, 1, 1, 1);
        cr.arc(at, peak, 2 * unit, 0, 2 * Math.PI);
        cr.fill();
    }

    // The top half of a glow round the sun, at full strength in `color`.
    _haloFor(color) {
        if (this._halo && this._haloColor === color)
            return this._halo;
        const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, HALO_SIZE * 2, HALO_SIZE);
        const cr = new Cairo.Context(surface);
        const gradient = new Cairo.RadialGradient(HALO_SIZE, HALO_SIZE, HALO_SIZE * 0.25, HALO_SIZE, HALO_SIZE, HALO_SIZE);
        gradient.addColorStopRGBA(0, ...color, 1);
        gradient.addColorStopRGBA(1, ...color, 0);
        cr.setSource(gradient);
        cr.paint();
        cr.$dispose();
        this._halo = surface;
        this._haloColor = color;
        return surface;
    }

    _drawLand(cr, w, h, horizon, ground, view, earth, unit) {
        const lift = h * 0.36;
        // Wider than the card at the front, so the nearest ridges run off its edges.
        const span = w * 1.12;

        // Ridges slide back continuously between the moments they are taken.
        // The live one at the front follows the music every frame; each one
        // taken starts out identical to it and then peels away behind.
        const phase = this._clock / this._interval;
        const live = {values: this._values(view.shown), palette: view.palette, beat: view.flash, accent: 1};
        const ridges = [live, ...this._rows];
        for (let r = ridges.length - 1; r >= 0; r--) {
            const ridge = ridges[r];
            const depth = r === 0 ? 0 : r - 1 + phase;
            const scale = 1 / (1 + depth * DEPTH);
            // 0 at the front to 1 at the back, for fading into the distance.
            const fog = Math.min(1, depth / ROWS);
            // The last ridge fades out rather than vanishing as it drops off.
            const fade = Math.min(1, ROWS - depth);
            if (fade <= 0)
                continue;
            const base = horizon + (ground - horizon) * scale;
            const width = span * scale;
            const left = (w - width) / 2;
            const values = ridge.values;
            const points = [];
            for (let i = 0; i < values.length; i++)
                points.push([left + i / (values.length - 1) * width, base - values[i] * lift * scale]);

            // Filled down to its own foot, which is enough to hide everything
            // behind it: further ridges stand higher up the picture.
            smoothLine(cr, points);
            cr.lineTo(left + width, base + 1);
            cr.lineTo(left, base + 1);
            cr.closePath();
            cr.setSourceRGBA(...earth(ridge.palette, fog), fade);
            cr.fill();

            const hue = mix(ridge.palette.primary, ridge.palette.secondary, fog);
            // Bars, phrases and sections stand out progressively more, so the
            // song's structure reads in the stripes.
            const accent = ridge.accent ?? 0;
            const color = mix(hue, [1, 1, 1], ridge.beat * [0.25, 0.55, 0.75, 0.85][accent]);
            // Fog thickens in a breakdown, swallowing the far ridges first.
            const haze = 1 - 0.5 * this._calm * fog;
            const alpha = Math.min(1, 0.95 - fog * 0.6 + ridge.beat * 0.3) * fade * haze;
            if (ridge.beat > 0.05 && accent > 0) {
                // A downbeat ridge glows, so the rhythm marches off as bright stripes.
                const reach = [0, 1, 1.3, 1.6][accent];
                cr.setOperator(Cairo.Operator.ADD);
                smoothLine(cr, points);
                cr.setLineWidth((4 + 8 * ridge.beat) * reach * scale * unit);
                // In the song's colour: glow tinted white reads as grey haze.
                // Sections glow in the second colour, to mark them apart.
                cr.setSourceRGBA(...(accent === 3 ? ridge.palette.secondary : hue),
                    0.2 * ridge.beat * fade * (accent >= 2 ? 1.25 : 1));
                cr.stroke();
                cr.setOperator(Cairo.Operator.OVER);
            }
            smoothLine(cr, points);
            cr.setLineWidth(((r === 0 ? 2.2 : 1.1) * (0.5 + 0.5 * scale) + ridge.beat * 1.4 * scale) * unit);
            cr.setSourceRGBA(...color, alpha);
            cr.stroke();
        }
    }
}
