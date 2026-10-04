import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import Soup from 'gi://Soup';

// Colours for a track with no art, or art with no colour in it: violet into
// teal, which reads as "music" without belonging to any one album.
export const DEFAULT_PALETTE = {
    primary: [0.62, 0.44, 1.0],
    secondary: [0.22, 0.86, 0.85],
    dark: [0.07, 0.06, 0.12],
};

const HUE_BINS = 12;
const SAMPLE_SIZE = 32;

function isCancelled(e) {
    return e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function rgbToHsv(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let h = 0;
    if (delta > 0) {
        if (max === r)
            h = ((g - b) / delta + 6) % 6;
        else if (max === g)
            h = (b - r) / delta + 2;
        else
            h = (r - g) / delta + 4;
        h /= 6;
    }
    return [h, max === 0 ? 0 : delta / max, max];
}

function hsvToRgb(h, s, v) {
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][((i % 6) + 6) % 6];
}

// The two strongest colours in a picture, made bright enough to glow on a
// dark card, and a deep shade of the first to paint the card with.
//
// Pixels are binned by hue and weighted by how colourful they are, so a small
// splash of red on a grey cover still wins over the grey.
export function paletteFromFile(path) {
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, SAMPLE_SIZE, SAMPLE_SIZE, false);
    const pixels = pixbuf.get_pixels();
    const stride = pixbuf.get_rowstride();
    const channels = pixbuf.get_n_channels();
    const bins = Array.from({length: HUE_BINS}, () => ({weight: 0, h: 0, s: 0, v: 0}));
    for (let y = 0; y < pixbuf.get_height(); y++) {
        for (let x = 0; x < pixbuf.get_width(); x++) {
            const at = y * stride + x * channels;
            const [h, s, v] = rgbToHsv(pixels[at] / 255, pixels[at + 1] / 255, pixels[at + 2] / 255);
            const weight = s * s * (0.25 + v);
            if (weight < 0.02)
                continue;
            const bin = bins[Math.floor(h * HUE_BINS) % HUE_BINS];
            bin.weight += weight;
            bin.h += h * weight;
            bin.s += s * weight;
            bin.v += v * weight;
        }
    }

    const ranked = bins
        .map((bin, index) => ({...bin, index}))
        .filter(bin => bin.weight > 0)
        .sort((a, b) => b.weight - a.weight);
    if (ranked.length === 0)
        return DEFAULT_PALETTE;

    const glow = bin => {
        const h = bin.h / bin.weight;
        const s = Math.min(1, Math.max(0.55, bin.s / bin.weight));
        return {h, rgb: hsvToRgb(h, s, Math.max(0.85, bin.v / bin.weight))};
    };
    const first = glow(ranked[0]);
    // A second hue well away from the first, or the first turned a third of
    // the way round the wheel when the cover is all one colour.
    const apart = ranked.find(bin => {
        const distance = Math.abs(bin.index - ranked[0].index);
        return Math.min(distance, HUE_BINS - distance) >= 2 && bin.weight > ranked[0].weight * 0.08;
    });
    const second = apart
        ? glow(apart).rgb
        : hsvToRgb((first.h + 0.33) % 1, 0.65, 0.95);
    return {
        primary: first.rgb,
        secondary: second,
        dark: hsvToRgb(first.h, 0.55, 0.13),
    };
}

// Cover art from Spotify's image server, kept in ~/.cache/resonance-gnome so
// the same album only downloads once.
export class ArtCache {
    constructor() {
        this._session = new Soup.Session({timeout: 15});
        this._cancellable = new Gio.Cancellable();
        this._dir = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_cache_dir(), 'resonance-gnome', 'art']));
        this._palettes = new Map();
    }

    // Calls back with the art's path and palette, straight away if it is cached.
    fetch(url, callback) {
        const name = url.split('/').pop().replace(/[^A-Za-z0-9]/g, '');
        if (!name)
            return;
        const file = this._dir.get_child(`${name}.jpg`);
        if (file.query_exists(null)) {
            callback(file.get_path(), this._palette(file.get_path()));
            return;
        }
        const message = Soup.Message.new('GET', url);
        if (!message)
            return;
        this._session.send_and_read_async(message, GLib.PRIORITY_LOW, this._cancellable, (session, result) => {
            try {
                const bytes = session.send_and_read_finish(result);
                if (message.get_status() !== Soup.Status.OK)
                    return;
                GLib.mkdir_with_parents(this._dir.get_path(), 0o755);
                file.replace_contents(bytes.get_data(), null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                callback(file.get_path(), this._palette(file.get_path()));
            } catch (e) {
                if (!isCancelled(e))
                    console.warn(`Resonance: art ${url} failed: ${e.message}`);
            }
        });
    }

    _palette(path) {
        if (!this._palettes.has(path)) {
            let palette = DEFAULT_PALETTE;
            try {
                palette = paletteFromFile(path);
            } catch (e) {
                console.warn(`Resonance: palette for ${path}: ${e.message}`);
            }
            this._palettes.set(path, palette);
        }
        return this._palettes.get(path);
    }

    destroy() {
        this._cancellable.cancel();
        this._session.abort();
    }
}
