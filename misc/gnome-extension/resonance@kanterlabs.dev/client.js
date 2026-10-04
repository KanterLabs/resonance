import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

Gio._promisify(Gio.SocketClient.prototype, 'connect_async');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish_utf8');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async');

const RETRY_SECONDS = 2;
const REQUEST_TIMEOUT_SECONDS = 8;
const encoder = new TextEncoder();

// Resonance names its socket resonance.sock, or resonance.<pid>.sock when a
// second instance finds the first one's in use. Prefer the plain name.
function socketPath() {
    const dir = Gio.File.new_for_path(
        GLib.build_filenamev([GLib.get_user_runtime_dir(), 'resonance']));
    const plain = dir.get_child('resonance.sock');
    if (plain.query_exists(null))
        return plain.get_path();
    try {
        const children = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        for (let info; (info = children.next_file(null));) {
            if (/^resonance\.\d+\.sock$/.test(info.get_name()))
                return dir.get_child(info.get_name()).get_path();
        }
    } catch {
        // No runtime directory means Resonance has never run this session.
    }
    return null;
}

function isCancelled(e) {
    return e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

// A connection to Resonance's local socket that keeps itself up while started.
// Lines come in three kinds: status snapshots (they have `mode`), audio frames
// (`audio`, only once subscribed) and responses to our own requests (`id`).
export class ResonanceClient {
    constructor({onStatus, onAudio, onConnected}) {
        this._onStatus = onStatus;
        this._onAudio = onAudio;
        this._onConnected = onConnected;
        this._nextId = 1;
        this._pending = new Map();
        this._audio = null;
        this._connection = null;
        this._writes = Promise.resolve();
    }

    get connected() {
        return this._connection !== null;
    }

    start() {
        if (this._cancellable)
            return;
        this._cancellable = new Gio.Cancellable();
        this._connect(this._cancellable);
    }

    stop() {
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._retry) {
            GLib.source_remove(this._retry);
            this._retry = 0;
        }
        this._drop();
    }

    // Ask for the audio feed at this rate and detail, or null to stop it. Kept
    // so a reconnect subscribes again.
    setAudio(feed) {
        this._audio = feed;
        if (this.connected)
            this._subscribe().catch(e => console.warn(`Resonance: audio feed: ${e.message}`));
    }

    request(method, params = {}) {
        if (!this.connected)
            return Promise.reject(new Error('Resonance is not running'));
        const id = this._nextId++;
        const line = JSON.stringify({protocol: 'resonance', version: 1, id, method, params});
        return new Promise((resolve, reject) => {
            const timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REQUEST_TIMEOUT_SECONDS, () => {
                this._pending.delete(id);
                reject(new Error(`${method} timed out`));
                return GLib.SOURCE_REMOVE;
            });
            this._pending.set(id, {resolve, reject, timeout});
            this._write(line).catch(e => this._settle(id, null, e));
        });
    }

    _subscribe() {
        return this._audio
            ? this.request('audio.subscribe', this._audio)
            : this.request('audio.unsubscribe');
    }

    async _connect(cancellable) {
        const path = socketPath();
        if (!path) {
            this._scheduleRetry(cancellable);
            return;
        }
        try {
            const client = new Gio.SocketClient();
            const connection = await client.connect_async(Gio.UnixSocketAddress.new(path), cancellable);
            if (cancellable.is_cancelled()) {
                connection.close(null);
                return;
            }
            this._connection = connection;
            this._output = connection.get_output_stream();
            const input = new Gio.DataInputStream({
                base_stream: connection.get_input_stream(),
                close_base_stream: false,
            });
            this._onConnected(true);
            if (this._audio)
                this._subscribe().catch(e => console.warn(`Resonance: audio feed: ${e.message}`));
            await this._readLoop(input, cancellable);
        } catch (e) {
            if (isCancelled(e))
                return;
            console.debug(`Resonance: socket ${path}: ${e.message}`);
        }
        if (cancellable.is_cancelled())
            return;
        this._drop();
        this._scheduleRetry(cancellable);
    }

    async _readLoop(input, cancellable) {
        for (;;) {
            const [line] = await input.read_line_async(GLib.PRIORITY_DEFAULT, cancellable);
            if (line === null)
                return;
            let message;
            try {
                message = JSON.parse(line);
            } catch {
                continue;
            }
            if (message.audio)
                this._onAudio(message.audio);
            else if (message.protocol === 'resonance' && message.id !== undefined)
                this._settle(message.id, message);
            else if (message.mode !== undefined)
                this._onStatus(message);
        }
    }

    _settle(id, message, error = null) {
        const pending = this._pending.get(id);
        if (!pending)
            return;
        this._pending.delete(id);
        GLib.source_remove(pending.timeout);
        if (error)
            pending.reject(error);
        else if (message.ok)
            pending.resolve(message.result);
        else
            pending.reject(new Error(message.error?.message ?? 'request failed'));
    }

    // Writes go out one at a time so two requests never interleave on the wire.
    _write(line) {
        const output = this._output;
        const bytes = new GLib.Bytes(encoder.encode(`${line}\n`));
        this._writes = this._writes
            .catch(() => {})
            .then(() => output.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, null));
        return this._writes;
    }

    _scheduleRetry(cancellable) {
        if (this._retry || cancellable.is_cancelled())
            return;
        this._retry = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RETRY_SECONDS, () => {
            this._retry = 0;
            if (!cancellable.is_cancelled())
                this._connect(cancellable);
            return GLib.SOURCE_REMOVE;
        });
    }

    _drop() {
        const wasConnected = this.connected;
        this._connection?.close(null);
        this._connection = null;
        this._output = null;
        this._writes = Promise.resolve();
        for (const id of [...this._pending.keys()])
            this._settle(id, null, new Error('Resonance disconnected'));
        if (wasConnected)
            this._onConnected(false);
    }
}
