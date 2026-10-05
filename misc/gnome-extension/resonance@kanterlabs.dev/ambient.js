import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BUILD = import.meta.url.match(/[?&]v=(\d+)/)?.[1] ?? '0';
const {Visualizer, MODES} = await import(`./visualizer.js?v=${BUILD}`);

// The visualizers draw in software, so a full-screen canvas is drawn at most
// this many physical pixels across and scaled up. The glow hides the
// difference, and it keeps a frame well inside its budget.
const MAX_RENDER = 1280;
// How long the track details stay bright after a change or a mouse move.
const INFO_SECONDS = 6;

// The visualizer filling the primary monitor, with the track in a corner.
export class Ambient {
    constructor({onAction, onMode, onClosed}) {
        this._onAction = onAction;
        this._onMode = onMode;
        this._onClosed = onClosed;
        this._isOpen = false;
        this._trackKey = null;
        this._build();
    }

    get isOpen() {
        return this._isOpen;
    }

    _build() {
        this._actor = new St.Widget({
            style_class: 'rz-ambient',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            can_focus: true,
            visible: false,
        });
        this._actor.connect('key-press-event', (_actor, event) => this._onKeyPress(event));
        this._actor.connect('motion-event', () => {
            this._wake();
            return Clutter.EVENT_PROPAGATE;
        });

        this._visualizer = new Visualizer({
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });
        this._visualizer.corner = 0;
        this._actor.add_child(this._visualizer);
        const disc = this._visualizer.disc;
        disc.x_align = Clutter.ActorAlign.CENTER;
        disc.y_align = Clutter.ActorAlign.CENTER;
        this._actor.add_child(disc);

        this._info = new St.BoxLayout({
            style_class: 'rz-ambient-info',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.END,
        });
        this._cover = new St.Widget({style_class: 'rz-ambient-cover', width: 96, height: 96});
        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title = new St.Label({style_class: 'rz-ambient-title'});
        this._artist = new St.Label({style_class: 'rz-ambient-artist'});
        for (const label of [this._title, this._artist]) {
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            text.add_child(label);
        }
        this._info.add_child(this._cover);
        this._info.add_child(text);
        this._actor.add_child(this._info);

        this._hint = new St.Label({
            style_class: 'rz-ambient-hint',
            text: 'Esc to close  ·  Tab to change view  ·  Space to pause',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
        });
        this._actor.add_child(this._hint);

        Main.layoutManager.uiGroup.add_child(this._actor);
    }

    toggle() {
        if (this._isOpen)
            this.close();
        else
            this.open();
    }

    open() {
        if (this._isOpen)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        this._actor.set_position(monitor.x, monitor.y);
        this._actor.set_size(monitor.width, monitor.height);

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const fraction = Math.min(1, MAX_RENDER / (Math.max(monitor.width, monitor.height) * scale));
        const width = Math.round(monitor.width * fraction);
        const height = Math.round(monitor.height * fraction);
        this._visualizer.set_size(width, height);
        this._visualizer.set_scale(1 / fraction, 1 / fraction);
        // The orbit's cover sits inside its ring, which is sized off the canvas.
        const disc = Math.round((Math.min(width, height) * 0.48 - 14) / fraction);
        this._visualizer.disc.set_size(disc, disc);

        // Raised above everything else in the shell, the top bar included.
        Main.layoutManager.uiGroup.set_child_above_sibling(this._actor, null);
        this._actor.show();
        const grab = Main.pushModal(this._actor, {actionMode: Shell.ActionMode.POPUP});
        if ((grab.get_seat_state() & Clutter.GrabState.KEYBOARD) === 0) {
            Main.popModal(grab);
            this._actor.hide();
            return;
        }
        this._grab = grab;
        this._isOpen = true;
        this._actor.grab_key_focus();
        this._visualizer.start();

        this._actor.remove_all_transitions();
        this._actor.opacity = 0;
        this._actor.ease({opacity: 255, duration: 450, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._hint.opacity = 255;
        this._wake();
    }

    close() {
        if (!this._isOpen)
            return;
        this._isOpen = false;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._clearDim();
        this._actor.remove_all_transitions();
        this._actor.ease({
            opacity: 0,
            duration: 250,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (!this._isOpen) {
                    this._visualizer.stop();
                    this._actor.hide();
                }
            },
        });
        this._onClosed();
    }

    destroy() {
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        this._clearDim();
        this._actor.destroy();
    }

    setMode(mode) {
        this._visualizer.setMode(mode);
    }

    setPlaying(playing) {
        this._visualizer.setPlaying(playing);
    }

    feed(audio) {
        this._visualizer.feed(audio);
    }

    setArt(path, palette) {
        const image = path ? `background-image: url("file://${path}");` : '';
        this._cover.style = image;
        this._visualizer.disc.style = image;
        this._visualizer.setPalette(palette);
    }

    setStatus(status) {
        const playable = status?.playable;
        this._title.text = playable?.title ?? playable?.name ?? 'Resonance';
        this._artist.text = playable?.artists?.join(', ') ?? (status ? '' : 'Resonance isn’t running');
        // A new track brings the details back up.
        const key = playable?.uri ?? null;
        if (key !== this._trackKey) {
            this._trackKey = key;
            if (this._isOpen)
                this._wake();
        }
    }

    // Bring the track details up, then let them dim back into the scene.
    _wake() {
        this._clearDim();
        this._info.remove_all_transitions();
        this._info.ease({opacity: 255, duration: 300, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._dim = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, INFO_SECONDS, () => {
            this._dim = 0;
            this._info.ease({opacity: 80, duration: 1500, mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD});
            this._hint.ease({opacity: 0, duration: 1500, mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD});
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearDim() {
        if (this._dim) {
            GLib.source_remove(this._dim);
            this._dim = 0;
        }
    }

    _onKeyPress(event) {
        const symbol = event.get_key_symbol();
        const state = event.get_state();
        const superHeld = (state & Clutter.ModifierType.SUPER_MASK) !== 0;
        if (symbol === Clutter.KEY_Escape ||
            (superHeld && (symbol === Clutter.KEY_m || symbol === Clutter.KEY_M))) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        const index = MODES.indexOf(this._visualizer.mode);
        const actions = {
            [Clutter.KEY_space]: () => this._onAction('play_pause'),
            [Clutter.KEY_Right]: () => this._onAction('next'),
            [Clutter.KEY_Left]: () => this._onAction('previous'),
            [Clutter.KEY_Tab]: () => this._onMode(MODES[(index + 1) % MODES.length]),
            [Clutter.KEY_ISO_Left_Tab]: () => this._onMode(MODES[(index + MODES.length - 1) % MODES.length]),
        };
        MODES.forEach((mode, i) => {
            actions[Clutter.KEY_1 + i] = () => this._onMode(mode);
        });
        this._wake();
        if (actions[symbol]) {
            actions[symbol]();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }
}
