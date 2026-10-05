import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// extension.js imports this module as popup.js?v=<mtime>; pass the same version
// on so an edit to any module is picked up by a reload too.
const BUILD = import.meta.url.match(/[?&]v=(\d+)/)?.[1] ?? '0';
const {ResonanceClient} = await import(`./client.js?v=${BUILD}`);
const {ArtCache, DEFAULT_PALETTE} = await import(`./palette.js?v=${BUILD}`);
const {Visualizer, MODES, MODE_LABELS, AUDIO_FEED} = await import(`./visualizer.js?v=${BUILD}`);
const {Ambient} = await import(`./ambient.js?v=${BUILD}`);

const POPUP_WIDTH = 600;
const POPUP_PADDING = 18;
// .rz-popup has a 1px border on each side.
const CONTENT_WIDTH = POPUP_WIDTH - POPUP_PADDING * 2 - 2;
const VISUALIZER_HEIGHT = 280;
// The cover in the middle of the orbit, a little inside the ring.
const DISC_SIZE = Math.round(VISUALIZER_HEIGHT * 0.48) - 14;
const UP_NEXT_ROWS = 3;
// How often the song map is asked for again while a view is open, so a first
// listen draws the skyline in as it goes.
const MAP_SECONDS = 3;
const ORIGINS = {radio: 'Radio', explicit: 'Queued'};

function formatTime(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function rgba([r, g, b], alpha) {
    return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;
}

// Serde writes the player mode as {"Playing": ...}, {"Paused": ...} or a bare
// "Stopped" / "FinishedTrack".
function modeName(mode) {
    return typeof mode === 'string' ? mode : Object.keys(mode ?? {})[0] ?? 'Stopped';
}

function label(styleClass, text = '') {
    const actor = new St.Label({style_class: styleClass, text, x_expand: true});
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return actor;
}

export class Popup {
    constructor(settings) {
        this._settings = settings;
        this._art = new ArtCache();
        this._status = null;
        this._statusAt = 0;
        this._coverUrl = null;
        this._isOpen = false;
        this._client = new ResonanceClient({
            onStatus: status => this._onStatus(status),
            onAudio: audio => this._onAudio(audio),
            onConnected: connected => {
                // What was playing is only known while Resonance is there to say.
                if (!connected) {
                    this._status = null;
                    this._ambient.setStatus(null);
                }
                if (this._isOpen)
                    this._render();
            },
        });
        this._ambient = new Ambient({
            onAction: action => this._action(action),
            onMode: mode => this._setMode(mode),
            onClosed: () => this._syncClient(),
        });

        this._buildUi();
        this._settings.connectObject('changed::visualizer', () => this._applyMode(), this);
        this._applyMode();
    }

    _buildUi() {
        this._backdrop = new St.Widget({reactive: true, can_focus: true, visible: false});
        this._backdrop.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));
        this._backdrop.connect('button-press-event', (_actor, event) => this._onBackdropPress(event));
        this._backdrop.connect('key-press-event', (_actor, event) => this._onKeyPress(event));

        this._popup = new St.BoxLayout({
            style_class: 'rz-popup',
            orientation: Clutter.Orientation.VERTICAL,
            width: POPUP_WIDTH,
            reactive: true,
            pivot_point: new Graphene.Point({x: 0.5, y: 0}),
        });
        // Full brightness: the blur covers the popup's whole rectangle, and any
        // darkening shows as grey squares outside the rounded corners.
        this._popup.add_effect(new Shell.BlurEffect({
            name: 'resonance-glass-blur',
            mode: Shell.BlurMode.BACKGROUND,
            radius: 30,
            brightness: 1.0,
        }));
        this._backdrop.add_child(this._popup);

        this._popup.add_child(this._buildHeader());
        this._popup.add_child(this._buildProgress());
        this._popup.add_child(this._buildControls());

        this._visualizer = new Visualizer({width: CONTENT_WIDTH, height: VISUALIZER_HEIGHT});
        this._visualizer.disc.set_size(DISC_SIZE, DISC_SIZE);
        const stage = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: CONTENT_WIDTH,
            height: VISUALIZER_HEIGHT,
        });
        stage.add_child(this._visualizer);
        this._visualizer.disc.x_align = Clutter.ActorAlign.CENTER;
        this._visualizer.disc.y_align = Clutter.ActorAlign.CENTER;
        stage.add_child(this._visualizer.disc);
        this._message = new St.Label({
            style_class: 'rz-message',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        stage.add_child(this._message);
        this._popup.add_child(stage);

        this._upNextTitle = new St.Label({style_class: 'rz-section-title', text: 'UP NEXT'});
        this._upNext = new St.BoxLayout({style_class: 'rz-up-next', orientation: Clutter.Orientation.VERTICAL});
        this._popup.add_child(this._upNextTitle);
        this._popup.add_child(this._upNext);

        Main.layoutManager.uiGroup.add_child(this._backdrop);
    }

    _buildHeader() {
        const header = new St.BoxLayout({style_class: 'rz-header'});
        this._cover = new St.Widget({style_class: 'rz-cover', width: 104, height: 104});
        header.add_child(this._cover);

        const text = new St.BoxLayout({
            style_class: 'rz-track',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title = label('rz-title');
        this._artist = label('rz-artist');
        this._album = label('rz-album');
        text.add_child(this._title);
        text.add_child(this._artist);
        text.add_child(this._album);

        const pills = new St.BoxLayout({style_class: 'rz-pills'});
        this._tempo = new St.BoxLayout({style_class: 'rz-pill', visible: false});
        this._beatDot = new St.Widget({style_class: 'rz-beat-dot', y_align: Clutter.ActorAlign.CENTER});
        this._tempoLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this._tempo.add_child(this._beatDot);
        this._tempo.add_child(this._tempoLabel);
        this._radio = new St.Label({style_class: 'rz-pill', text: 'Radio', visible: false});
        pills.add_child(this._tempo);
        pills.add_child(this._radio);
        text.add_child(pills);

        header.add_child(text);
        return header;
    }

    _buildProgress() {
        const box = new St.BoxLayout({style_class: 'rz-progress-box', orientation: Clutter.Orientation.VERTICAL});
        this._track = new St.Widget({
            style_class: 'rz-progress',
            width: CONTENT_WIDTH,
            reactive: true,
            track_hover: true,
        });
        this._fill = new St.Widget({style_class: 'rz-progress-fill'});
        this._track.add_child(this._fill);
        this._track.connect('button-press-event', (actor, event) => this._seek(actor, event));
        box.add_child(this._track);

        const times = new St.BoxLayout({style_class: 'rz-times'});
        this._elapsed = new St.Label({style_class: 'rz-time', x_expand: true});
        this._duration = new St.Label({style_class: 'rz-time'});
        times.add_child(this._elapsed);
        times.add_child(this._duration);
        box.add_child(times);
        return box;
    }

    _buildControls() {
        const row = new St.BoxLayout({style_class: 'rz-controls'});
        const button = (icon, action, extra = '') => {
            const actor = new St.Button({
                style_class: `rz-button ${extra}`,
                can_focus: true,
                child: new St.Icon({icon_name: icon}),
            });
            actor.connect('clicked', () => this._action(action));
            row.add_child(actor);
            return actor;
        };
        button('media-skip-backward-symbolic', 'previous');
        this._playButton = button('media-playback-start-symbolic', 'play_pause', 'rz-play');
        button('media-skip-forward-symbolic', 'next');

        row.add_child(new St.Widget({x_expand: true}));
        this._modeButtons = new Map();
        for (const mode of MODES) {
            const chip = new St.Button({style_class: 'rz-mode', label: MODE_LABELS[mode], can_focus: true});
            chip.connect('clicked', () => this._settings.set_string('visualizer', mode));
            this._modeButtons.set(mode, chip);
            row.add_child(chip);
        }
        return row;
    }

    toggle() {
        if (this._isOpen)
            this.close();
        else
            this.open();
    }

    toggleAmbient() {
        if (this._ambient.isOpen) {
            this._ambient.close();
            return;
        }
        this.close();
        this._ambient.setStatus(this._status);
        this._ambient.setPlaying(this._playing());
        this._ambient.open();
        this._syncClient();
    }

    // Resonance is listened to while either view is showing, and not at all
    // when both are shut.
    _syncClient() {
        if (this._isOpen || this._ambient.isOpen) {
            this._client.setAudio(AUDIO_FEED);
            this._client.start();
            this._mapClock ||= GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, MAP_SECONDS, () => {
                this._fetchMap();
                return GLib.SOURCE_CONTINUE;
            });
        } else {
            this._client.stop();
            if (this._mapClock) {
                GLib.source_remove(this._mapClock);
                this._mapClock = 0;
            }
        }
    }

    // Ask Resonance what it knows of the playing song's shape. Builds without
    // song maps refuse, and Ridges simply goes without a skyline.
    _fetchMap() {
        if (!this._client.connected || !this._status?.playable)
            return;
        this._client.request('song.map').then(map => {
            if (map.uri !== this._status?.playable?.uri)
                return;
            this._visualizer.setSongMap(map);
            this._ambient.setSongMap(map);
        }).catch(() => {});
    }

    open() {
        if (this._isOpen)
            return;

        const monitor = Main.layoutManager.primaryMonitor;
        this._popup.set_position(
            Math.round(monitor.x + (monitor.width - POPUP_WIDTH) / 2),
            Math.round(monitor.y + monitor.height * 0.1));

        this._backdrop.show();
        const grab = Main.pushModal(this._backdrop, {actionMode: Shell.ActionMode.POPUP});
        if ((grab.get_seat_state() & Clutter.GrabState.KEYBOARD) === 0) {
            Main.popModal(grab);
            this._backdrop.hide();
            return;
        }
        this._grab = grab;
        this._isOpen = true;
        this._backdrop.grab_key_focus();

        this._syncClient();
        this._visualizer.start();
        this._clock = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._renderProgress();
            return GLib.SOURCE_CONTINUE;
        });
        this._render();

        this._popup.remove_all_transitions();
        this._popup.opacity = 0;
        this._popup.scale_x = this._popup.scale_y = 0.97;
        this._popup.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: 160,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    close() {
        if (!this._isOpen)
            return;
        this._isOpen = false;
        this._releaseGrab();
        // Nothing is drawn or streamed while both views are shut.
        this._syncClient();
        this._stopClock();

        this._popup.remove_all_transitions();
        this._popup.ease({
            opacity: 0,
            scale_x: 0.98,
            scale_y: 0.98,
            duration: 110,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (!this._isOpen) {
                    this._visualizer.stop();
                    this._backdrop.hide();
                }
            },
        });
    }

    destroy() {
        this._releaseGrab();
        // Everything that can call back into the views goes first: stopping the
        // client reports the disconnect to them, so they must still be there.
        this._client.stop();
        this._stopClock();
        this._art.destroy();
        if (this._mapClock)
            GLib.source_remove(this._mapClock);
        this._settings.disconnectObject(this);
        this._ambient.destroy();
        this._backdrop.destroy();
    }

    _stopClock() {
        if (this._clock) {
            GLib.source_remove(this._clock);
            this._clock = 0;
        }
    }

    _releaseGrab() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
    }

    _onBackdropPress(event) {
        const [x, y] = event.get_coords();
        const [px, py] = this._popup.get_transformed_position();
        const [pw, ph] = this._popup.get_transformed_size();
        if (x < px || x > px + pw || y < py || y > py + ph)
            this.close();
        return Clutter.EVENT_PROPAGATE;
    }

    _onKeyPress(event) {
        const symbol = event.get_key_symbol();
        const state = event.get_state();
        const superHeld = (state & Clutter.ModifierType.SUPER_MASK) !== 0;
        const isM = symbol === Clutter.KEY_m || symbol === Clutter.KEY_M;
        if (superHeld && isM && (state & Clutter.ModifierType.SHIFT_MASK) !== 0) {
            this.toggleAmbient();
            return Clutter.EVENT_STOP;
        }
        if ((superHeld && isM) ||
            symbol === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        const index = MODES.indexOf(this._visualizer.mode);
        const actions = {
            [Clutter.KEY_space]: () => this._action('play_pause'),
            [Clutter.KEY_Right]: () => this._action('next'),
            [Clutter.KEY_n]: () => this._action('next'),
            [Clutter.KEY_Left]: () => this._action('previous'),
            [Clutter.KEY_p]: () => this._action('previous'),
            [Clutter.KEY_Tab]: () => this._setMode(MODES[(index + 1) % MODES.length]),
            [Clutter.KEY_v]: () => this._setMode(MODES[(index + 1) % MODES.length]),
            [Clutter.KEY_ISO_Left_Tab]: () => this._setMode(MODES[(index + MODES.length - 1) % MODES.length]),
            [Clutter.KEY_f]: () => this.toggleAmbient(),
        };
        MODES.forEach((mode, i) => {
            actions[Clutter.KEY_1 + i] = () => this._setMode(mode);
        });
        if (actions[symbol]) {
            actions[symbol]();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _setMode(mode) {
        this._settings.set_string('visualizer', mode);
    }

    _applyMode() {
        const mode = this._settings.get_string('visualizer');
        this._visualizer.setMode(mode);
        this._ambient.setMode(mode);
        for (const [name, chip] of this._modeButtons) {
            if (name === this._visualizer.mode)
                chip.add_style_pseudo_class('checked');
            else
                chip.remove_style_pseudo_class('checked');
        }
    }

    _action(action, value) {
        const params = value === undefined ? {action} : {action, value};
        this._client.request('player.action', params)
            .catch(e => console.warn(`Resonance: ${action}: ${e.message}`));
    }

    _seek(actor, event) {
        const duration = this._status?.playable?.duration;
        if (!duration)
            return Clutter.EVENT_PROPAGATE;
        const [x] = event.get_coords();
        const [left] = actor.get_transformed_position();
        const fraction = Math.min(1, Math.max(0, (x - left) / actor.width));
        const position = Math.round(fraction * duration);
        this._action('seek', position);
        // Show the new position now rather than at the next status.
        this._status.prototype.position_ms = position;
        this._statusAt = GLib.get_monotonic_time();
        this._renderProgress();
        return Clutter.EVENT_STOP;
    }

    _onStatus(status) {
        const track = status?.playable?.uri ?? null;
        this._status = status;
        this._statusAt = GLib.get_monotonic_time();
        // A new song: forget the old one's skyline straight away and ask for this one's.
        if (track !== this._mapTrack) {
            this._mapTrack = track;
            this._visualizer.setSongMap(null);
            this._ambient.setSongMap(null);
            this._fetchMap();
        }
        this._syncCover();
        this._ambient.setStatus(status);
        this._ambient.setPlaying(this._playing());
        if (this._isOpen)
            this._render();
    }

    _onAudio(audio) {
        const duration = this._status?.playable?.duration;
        const progress = duration ? this._position() / duration : null;
        this._visualizer.setProgress(progress);
        this._visualizer.feed(audio);
        if (this._ambient.isOpen) {
            this._ambient.setProgress(progress);
            this._ambient.feed(audio);
        }
        if (audio.tempo) {
            this._tempo.show();
            this._tempoLabel.text = `${Math.round(audio.tempo)} BPM`;
        }
        if (this._lastBeats !== undefined && audio.beats > this._lastBeats) {
            this._beatDot.remove_all_transitions();
            this._beatDot.opacity = 255;
            this._beatDot.ease({opacity: 70, duration: 260, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        this._lastBeats = audio.beats;
    }

    _playing() {
        return modeName(this._status?.mode) === 'Playing';
    }

    // Where playback is now: the last reported position, moved on by however
    // long it has been playing since.
    _position() {
        const status = this._status;
        if (!status?.prototype)
            return 0;
        const elapsed = this._playing() ? (GLib.get_monotonic_time() - this._statusAt) / 1000 : 0;
        return Math.min(status.playable?.duration ?? 0, status.prototype.position_ms + elapsed);
    }

    _render() {
        const playable = this._status?.playable;
        const connected = this._client.connected;
        if (!connected)
            this._showMessage('Resonance isn’t running');
        else if (!playable)
            this._showMessage('Nothing playing');
        else
            this._showMessage(null);

        this._title.text = playable?.title ?? playable?.name ?? 'Resonance';
        this._artist.text = playable?.artists?.join(', ') ?? '';
        this._album.text = playable?.album ?? '';
        this._radio.visible = !!this._status?.prototype?.radio_active;
        this._playButton.child.icon_name = this._playing()
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
        this._visualizer.setPlaying(this._playing());
        this._syncCover();
        this._renderUpNext();
        this._renderProgress();
    }

    // Fetch the cover when the track changes, for both views.
    _syncCover() {
        const cover = this._status?.playable?.cover_url ?? null;
        if (cover === this._coverUrl)
            return;
        this._coverUrl = cover;
        this._tempo.hide();
        if (cover)
            this._art.fetch(cover, (path, palette) => this._applyArt(cover, path, palette));
        else
            this._applyArt(null, null, DEFAULT_PALETTE);
    }

    _showMessage(text) {
        this._message.visible = text !== null;
        this._message.text = text ?? '';
    }

    _applyArt(url, path, palette) {
        if (url !== this._coverUrl)
            return;
        const image = path ? `background-image: url("file://${path}");` : '';
        this._cover.style = image;
        this._visualizer.disc.style = image;
        this._visualizer.setPalette(palette);
        this._ambient.setArt(path, palette);
        // The glass takes on the cover's colour, deep enough for white text.
        this._popup.style =
            `background-gradient-start: ${rgba(palette.dark, 0.78)};` +
            `background-gradient-end: ${rgba([0.04, 0.04, 0.06], 0.8)};`;
        this._fill.style = `background-color: ${rgba(palette.primary, 0.95)};`;
        this._beatDot.style = `background-color: ${rgba(palette.secondary, 1)};`;
    }

    _renderProgress() {
        const duration = this._status?.playable?.duration ?? 0;
        const position = this._position();
        this._fill.width = duration ? Math.round(CONTENT_WIDTH * position / duration) : 0;
        this._elapsed.text = duration ? formatTime(position) : '';
        this._duration.text = duration ? formatTime(duration) : '';
    }

    _renderUpNext() {
        const prototype = this._status?.prototype;
        const tracks = prototype?.up_next ?? [];
        // Status arrives twice a second; only rebuild when the list changed.
        const key = JSON.stringify([tracks.slice(0, UP_NEXT_ROWS).map(track => track.uri),
            prototype?.up_next_origins?.slice(0, UP_NEXT_ROWS)]);
        if (key === this._upNextKey)
            return;
        this._upNextKey = key;
        this._upNext.destroy_all_children();
        this._upNextTitle.visible = tracks.length > 0;
        tracks.slice(0, UP_NEXT_ROWS).forEach((track, index) => {
            const row = new St.BoxLayout({style_class: 'rz-next-row'});
            const text = label('rz-next-title', track.title);
            const artist = new St.Label({style_class: 'rz-next-artist', text: track.artists?.join(', ') ?? ''});
            artist.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            row.add_child(text);
            row.add_child(artist);
            const origin = ORIGINS[prototype.up_next_origins?.[index]];
            if (origin)
                row.add_child(new St.Label({style_class: 'rz-origin', text: origin}));
            this._upNext.add_child(row);
        });
    }
}
