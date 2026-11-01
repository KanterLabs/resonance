# Resonance user documentation

Resonance is the maintained KanterLabs product. On Unix, `resonance` starts the Rust playback
engine and the standalone OpenTUI workspace; Windows currently uses the retained Cursive
interface. Use `resonance --legacy-ui` when you need that Cursive interface on Unix. The detailed
key bindings and configuration reference below describes that retained interface; see the
[OpenTUI workspace guide](opentui-prototype.md) for the current default workspace.

The canonical source is maintained in [KanterLabs' Gitea](https://gitea.home.shanekanterman.dev).
The public
[KanterLabs/resonance GitHub mirror](https://github.com/KanterLabs/resonance) is the public source
and issue link. Existing installations may use the legacy `ncspot` executable and data directories;
Resonance reuses populated legacy paths according to the documented selection rules.

## Installation

### Current Resonance source build

Clone the public mirror (or the canonical KanterLabs Gitea source when available), then build the
Rust backend and standalone OpenTUI executable together:

```sh
git clone https://github.com/KanterLabs/resonance
cd resonance
cargo build --release
cd prototype/opentui
bun install --frozen-lockfile
bun run build
cd ../..
install -m 0755 prototype/opentui/dist/resonance-opentui target/release/resonance-opentui
./target/release/resonance
```

Keep `resonance`, `resonance-opentui`, and the retained `ncspot` executable alias together when
installing release artifacts. `resonance-update` is the primary updater; `ncspot-update` remains a
forwarding compatibility alias. See [package maintainer instructions](package_maintainers.md) for
generated man pages, completions, notices, and the optional `resonance-wezterm` helper.

### Upstream ncspot distribution instructions

The package channels in this subsection belong to the original upstream **ncspot** project. They
are retained for users of an existing upstream installation and are not Resonance packages.

[![Upstream ncspot packaging status](https://repology.org/badge/vertical-allrepos/ncspot.svg)](https://repology.org/project/ncspot/versions)

### On macOS
`ncspot` is available via [Homebrew](https://brew.sh/):

```zsh
brew install ncspot
```

### On Windows
`ncspot` is available via [Scoop](https://scoop.sh/):

```powershell
scoop install ncspot
```

or via [winget](https://learn.microsoft.com/en-us/windows/package-manager/winget/):

```powershell
winget install hrkfdn.ncspot
```

### On Linux
<div>
<a href="https://flathub.org/apps/details/io.github.hrkfdn.ncspot"><img width="130" alt="Download on Flathub" src="https://flathub.org/assets/badges/flathub-badge-en.png"/></a>
<a href="https://snapcraft.io/ncspot"><img alt="Download on Snapcraft" src="https://snapcraft.io//ncspot/badge.svg"/></a>
</div>

Your distribution may have packaged `ncspot` in its package repository.
If so, simply install using your distribution's package manager - it
is by far the easiest way. If not, you can build from source instead.
See [Compiling](/doc/developers.md).

In case your package manager does not perform dependency resolution,
here are the runtime dependencies:

- `dbus`, `libncurses`, `libssl`
- `libpulse` (or `portaudio`, if built using the PortAudio backend)
- `libxcb` (if built with the `clipboard` feature)

### On BSD's
Your distribution may have packaged `ncspot` in its package repository.
If so, simply install using your distribution's package manager - it
is by far the easiest way. If not, you can build from source instead.
See [Compiling](/doc/developers.md).

### From [crates.io](https://crates.io/crates/ncspot)

`ncspot` can be installed with `cargo`. The `cargo` documentation recommends against installing
software with it. If another option is available from the ones above, it should be preferred. If no
recent version is available for your OS, you can use the following command to install `ncspot` from
[crates.io](https://crates.io/crates/ncspot).

```zsh
# The --locked option is important and the compilation process might fail without it
cargo install --locked ncspot
```

## Retained Cursive interface

See [Retained Cursive interface](users-interface.md#retained-cursive-interface).

### Key Bindings

See [Key Bindings](users-interface.md#key-bindings).

### Navigation

See [Navigation](users-interface.md#navigation).

### Playback

See [Playback](users-interface.md#playback).

### Context Menus

See [Context Menus](users-interface.md#context-menus).

### Sharing

See [Sharing](users-interface.md#sharing).

### Queue

See [Queue](users-interface.md#queue).

### Now Playing

See [Now Playing](users-now-playing.md#now-playing).

### Statusbar

See [Statusbar](users-interface.md#statusbar).

### Casting

See [Casting](users-interface.md#casting).

### Lists

See [Lists](users-interface.md#lists).

### Volume and seeking

See [Volume and seeking](users-interface.md#volume-and-seeking).

### Library

See [Library](users-interface.md#library).

### Vim-Like Search Bar

See [Vim-Like Search Bar](users-interface.md#vim-like-search-bar).

### Vim-Like Commands

See [Vim-Like Commands](users-commands.md#vim-like-commands).

## Remote control (IPC)
Apart from MPRIS, Resonance creates a domain socket on UNIX platforms (Linux, macOS, *BSD). The
socket is created at `USER_RUNTIME_PATH/resonance.sock`; the runtime directory is selected by the
platform and can vary between sessions. Run `resonance info` and use its `USER_RUNTIME_PATH`
value rather than assuming a cache directory or a legacy `ncspot.sock` path. Applications or
scripts can connect to this socket to send commands or be notified of the currently playing track,
for example with `netcat`:

```
% USER_RUNTIME_PATH="$(resonance info | sed -n 's/^USER_RUNTIME_PATH //p')"
% nc -U "$USER_RUNTIME_PATH/resonance.sock"
play
{"mode":{"Playing":{"secs_since_epoch":1672249086,"nanos_since_epoch":547517730}},"playable":{"type":"Track","id":"2wcrQZ7ZJolYEfIaPP9yL4","uri":"spotify:track:2wcrQZ7ZJolYEfIaPP9yL4","title":"Hit Me Where It Hurts","track_number":4,"disc_number":1,"duration":184132,"artists":["Caroline Polachek"],"artist_ids":["4Ge8xMJNwt6EEXOzVXju9a"],"album":"Pang","album_id":"4ClyeVlAKJJViIyfVW0yQD","album_artists":["Caroline Polachek"],"cover_url":"https://i.scdn.co/image/ab67616d0000b2737d983e7bf67c2806218c2759","url":"https://open.spotify.com/track/2wcrQZ7ZJolYEfIaPP9yL4","added_at":"2022-12-19T22:41:05Z","list_index":0}}
playpause
{"mode":{"Paused":{"secs":25,"nanos":575000000}},"playable":{"type":"Track","id":"2wcrQZ7ZJolYEfIaPP9yL4","uri":"spotify:track:2wcrQZ7ZJolYEfIaPP9yL4","title":"Hit Me Where It Hurts","track_number":4,"disc_number":1,"duration":184132,"artists":["Caroline Polachek"],"artist_ids":["4Ge8xMJNwt6EEXOzVXju9a"],"album":"Pang","album_id":"4ClyeVlAKJJViIyfVW0yQD","album_artists":["Caroline Polachek"],"cover_url":"https://i.scdn.co/image/ab67616d0000b2737d983e7bf67c2806218c2759","url":"https://open.spotify.com/track/2wcrQZ7ZJolYEfIaPP9yL4","added_at":"2022-12-19T22:41:05Z","list_index":0}}
```

Each time the playback status changes (i.e. after sending the `play`/`playpause`
command or simply by playing the queue), the current status will be published as
a JSON structure.

Possible use cases for this could be:
- Controlling a detached Resonance session (in `tmux` for example)
- Displaying the currently playing track in your favorite application/status bar (see below)
- Setting up routines, i.e. to play specific songs/playlists when Resonance starts

### Extracting info on currently playing song
Using `netcat` and the domain socket, you can query the currently playing track
and other relevant information. Note that not all `netcat` versions are suitable,
as they typically tend to keep the connection to the socket open. OpenBSD's
`netcat` offers a work-around: by using the `-W` flag, it will close after a
specific number of packets have been received.

```
% USER_RUNTIME_PATH="$(resonance info | sed -n 's/^USER_RUNTIME_PATH //p')"
% nc -W 1 -U "$USER_RUNTIME_PATH/resonance.sock"
{"mode":{"Playing":{"secs_since_epoch":1675188934,"nanos_since_epoch":50913345}},"playable":{"type":"Track","id":"5Cp6a1h2VnuOtsh1Nqxfv6","uri":"spotify:track:5Cp6a1h2VnuOtsh1Nqxfv6","title":"New Track","track_number":1,"disc_number":1,"duration":498358,"artists":["Francis Bebey"],"artist_ids":["0mdmrbu5UZ32uRcRp2z6mr"],"album":"African Electronic Music (1975-1982)","album_id":"7w99Aae1tYSTSb1OiDnxYY","album_artists":["Francis Bebey"],"cover_url":"https://i.scdn.co/image/ab67616d0000b2736ab57cedf27177fae1eaed87","url":"https://open.spotify.com/track/5Cp6a1h2VnuOtsh1Nqxfv6","added_at":"2020-12-22T09:57:17Z","list_index":0}}
```

This results in a single output in `JSON` format, which can e.g. be parsed using [jq](https://stedolan.github.io/jq/).
For example, you can get the currently playing artist and title in your
terminal as follows:

```
% nc -W 1 -U "$USER_RUNTIME_PATH/resonance.sock" | jq '.playable.title'
"PUMPIN' JUMPIN'"

% nc -W 1 -U "$USER_RUNTIME_PATH/resonance.sock" | jq '.playable.artists[0]'
"Hideki Naganuma"
```

### Audio feed for visualizers
The status above goes out at most twice a second, which is too slow to draw music
by. A visualizer can ask its connection for a separate audio feed instead, with a
versioned request (one line):

```
{"protocol":"resonance","version":1,"id":1,"method":"audio.subscribe","params":{"fps":60,"bands":64,"waveform":256}}
```

`fps` is 1 to 60 (default 30), `bands` is 0 to 128 (default 64) and `waveform` is 0 to
512 points (default 0). After the response, that connection also receives a line
like this at the requested rate while sound is playing, and one `"live":false` frame
when it stops:

```
{"audio":{"live":true,"bands":[0.41,0.63,...],"waveform":[-0.12,0.34,...],"level":0.74,"pulse":0.3,"beats":812,"tempo":92.3}}
```

`bands` run from 40Hz to 15kHz on a log scale and `level` is overall loudness, each 0
to 1. `waveform` is the last ~23ms of audio from -1 to 1. `pulse` jumps on a beat
and fades over a fraction of a second; `beats` counts every beat so far, so a change
between frames means one landed. `tempo` is in beats per minute, or null until
enough beats have been heard. Send `audio.unsubscribe` to stop the feed. Other
connections are unaffected. `misc/gnome-extension` uses this feed for its popup.

Resonance also learns the shape of each song as it plays: the track is cut into 200
equal stretches, each remembering its loudness, bass, middle and treble, averaged over
every listen and kept in `song_maps.json` in the cache directory. `song.map` returns
it for the playing track, or for `params.uri`:

```
{"uri":"spotify:track:...","duration_ms":257775,"buckets":200,"heard":0.62,"level":[0.71,0.74,null,...],"bass":[...],"mid":[...],"treble":[...]}
```

Each lane holds one value from 0 to 1 per stretch, or `null` for stretches not heard
yet. `heard` is the share that has been. The answer includes the listen in progress.

## Configuration

See [Configuration](users-configuration.md#configuration).

### Custom Keybindings

See [Custom Keybindings](users-configuration.md#custom-keybindings).

### Proxy

See [Proxy](users-configuration.md#proxy).

### Theming

See [Theming](users-configuration.md#theming).

### Track Formatting

See [Track Formatting](users-configuration.md#track-formatting).

### Notification Formatting

See [Notification Formatting](users-configuration.md#notification-formatting).

### Cover Drawing

See [Cover Drawing](users-configuration.md#cover-drawing).

## Authentication
Resonance uses OAuth2 for authentication. When launched for the first time, a link will be generated
that can be opened in any browser. After logging in on the displayed page, you can start to use
Resonance. The OAuth2 flow is the only supported one, as username/password authentication has been
removed by Spotify.

The credentials are stored in `librespot/credentials.json` in the user's cache directory. Run
`resonance info` to show the location of this directory.

The `logout` command can be used to remove cached credentials. See
[Vim-Like Commands](users-commands.md#vim-like-commands).
