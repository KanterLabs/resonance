import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// GNOME Shell caches ES modules for the whole session. Importing the popup with
// the newest module mtime in the URL means a disable/enable picks up edits
// without logging out. popup.js passes the same version on to the others.
const MODULES = ['popup.js', 'client.js', 'palette.js', 'visualizer.js', 'draw.js', 'ridges.js', 'ambient.js'];

function popupUrl(dir) {
    const version = Math.max(...MODULES.map(name => dir.get_child(name)
        .query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null)
        .get_modification_date_time().to_unix()));
    return `${dir.get_child('popup.js').get_uri()}?v=${version}`;
}

export default class ResonanceExtension extends Extension {
    async enable() {
        const token = this._token = {};
        const {Popup} = await import(popupUrl(this.dir));
        if (this._token !== token)
            return;

        this._settings = this.getSettings();
        this._popup = new Popup(this._settings);
        // POPUP mode is left out on purpose: while the popup holds its modal
        // grab it handles Super+M itself, so the key never double-fires.
        Main.wm.addKeybinding(
            'toggle-popup',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._popup.toggle());
        Main.wm.addKeybinding(
            'toggle-ambient',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._popup.toggleAmbient());
    }

    disable() {
        this._token = null;
        if (this._popup) {
            Main.wm.removeKeybinding('toggle-popup');
            Main.wm.removeKeybinding('toggle-ambient');
            this._popup.destroy();
            this._popup = null;
        }
        this._settings = null;
    }
}
