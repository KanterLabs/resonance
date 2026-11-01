[User guide](users.md)

## Configuration
Configuration is saved to the `config.toml` file in the platform's standard configuration directory.
Run `resonance info` to show the location of this directory on your platform. To reload the
configuration during runtime use the `reload` command.

Possible configuration values are:

| Name                            | Description                                                    | Possible values                                                                       | Default             |
|---------------------------------|----------------------------------------------------------------|---------------------------------------------------------------------------------------|---------------------|
| `command_key`                   | Key to open command line                                       | Single character                                                                      | `:`                 |
| `initial_screen`                | Screen to show after startup                                   | `"library"`, `"search"`, `"queue"`, `"playing"`, `"cover"`<sup>[1]</sup>              | `"library"`         |
| `roku_hosts`                    | Addresses of Rokus to offer for casting, if the network search does not find them | List of addresses, e.g. `["10.0.0.41"]`                              |                     |
| `use_nerdfont`                  | Turn nerdfont glyphs on/off                                    | `true`, `false`                                                                       | `false`             |
| `flip_status_indicators`        | Reverse play/pause icon meaning<sup>[2]</sup>                  | `true`, `false`                                                                       | `false`             |
| `backend`                       | Audio backend to use                                           | String<sup>[3]</sup>                                                                  |                     |
| `backend_device`                | Audio device to configure the backend                          | String                                                                                |                     |
| `audio_cache`                   | Enable caching of audio files                                  | `true`, `false`                                                                       | `true`              |
| `audio_cache_size`              | Maximum size of audio cache in MiB                             | Number                                                                                |                     |
| `volnorm`                       | Enable volume normalization                                    | `true`, `false`                                                                       | `false`             |
| `volnorm_pregain`               | Normalization pregain to apply in dB (if enabled)              | Number                                                                                | `0.0`               |
| `default_keybindings`           | Enable default keybindings                                     | `true`, `false`                                                                       | `false`             |
| `notify`<sup>[4]</sup>          | Enable desktop notifications                                   | `true`, `false`                                                                       | `false`             |
| `bitrate`                       | Audio bitrate to use for streaming                             | `96`, `160`, `320`                                                                    | `320`               |
| `gapless`                       | Enable gapless playback                                        | `true`, `false`                                                                       | `true`              |
| `shuffle`                       | Set default shuffle state                                      | `true`, `false`                                                                       | `false`             |
| `repeat`                        | Set default repeat mode                                        | `"off"`, `"track"`, `"playlist"`                                                      | `"off"`             |
| `radio_discovery`               | Set the local radio exploration level at startup               | `0` - `100`                                                                           | `50`                |
| `arcs_preview_lookup`           | Let Arcs measure songs you haven't played from Deezer's 30 second previews. Sends song titles, artists and ISRCs to Deezer; only the measured numbers are kept, never audio | `true`, `false` | `true` |
| `playback_state`                | Set default playback state                                     | `"Stopped"`, `"Paused"`, `"Playing"`, `"Default"`                                     | `"Paused"`          |
| `library_tabs`                  | Tabs to show in library screen                                 | Array of `"tracks"`, `"albums"`, `"artists"`, `"playlists"`, `"podcasts"`, `"browse"` | All tabs            |
| `cover_max_scale`<sup>[1]</sup> | Set maximum scaling ratio for cover art                        | Number                                                                                | No limit            |
| `hide_display_names`            | Hides spotify usernames in the library header and on playlists | `true`, `false`                                                                       | `false`             |
| `statusbar_format`              | Formatting for tracks in the statusbar                         | See [track_formatting](#track-formatting)                                             | `%title · %artists` |
| `visualizer_fps`                | Frame rate of the now playing visualizer, `0` to disable it and the other now playing motion with it | `0` - `60`                                                                            | `20`                |
| `visualizer_style`              | Shape the now playing visualizer takes                         | `"bars"`, `"mirror"`, `"wave"`, `"vu"`                                                | `"bars"`            |
| `waveform`                      | Draw the progress bar as the track's own waveform              | `true`, `false`                                                                       | `true`              |
| `cover_accent`                  | Tint the card, statusbar and lists with the album cover's own colour | `true`, `false`                                                                 | `true`              |
| `beat_pulse`                    | Brighten the now playing card and the statusbar progress bar in time with the beat | `true`, `false`                                                                       | `true`              |
| `[track_format]`                | Set active fields shown in Library/Queue views                 | See [track formatting](#track-formatting)                                             |                     |
| `[notification_format]`         | Set the text displayed in notifications<sup>[4]</sup>          | See [notification formatting](#notification-formatting)                               |                     |
| `[theme]`                       | Custom theme                                                   | See [custom theme](#theming)                                                          |                     |
| `[keybindings]`                 | Custom keybindings                                             | See [custom keybindings](#custom-keybindings)                                         |                     |
| `ap_port`                       | Set ap-port for librespot (for restrictive firewalls)          | `80`, `443`, `4070`                                                                   |                     |

1. If built with the `cover` feature.
2. By default the statusbar's play button shows a pause icon while a track is
   playing and a play icon while it is not, naming what a click will do. If this
   setting is enabled, it shows the current state instead.
3. Run `resonance -h` for a list of devices.
4. If built with the `notify` feature.

### Custom Keybindings
Keybindings can be configured in `[keybindings]` section in `config.toml`.

Each key-value pair specifies one keybinding, where the key is a string in the
format of:

```
[MODIFIER+]<CHAR|NAMED_KEY>
where:
  MODIFIER: Shift|Alt|Ctrl
  CHAR: Any printable character
  NAMED_KEY: Enter|Space|Tab|Backspace|Esc|Left|Right|Up|Down
    |Ins|Del|Home|End|PageUp|PageDown|PauseBreak|NumpadCenter
    |F0|F1|F2|F3|F4|F5|F6|F7|F8|F9|F10|F11|F12
```

For implementation see [commands::CommandManager::parse_key](/src/commands.rs).

Its value is a string that can be parsed as a command. See
[Vim-Like Commands](users-commands.md#vim-like-commands).

<details>
  <summary>Examples: (Click to show/hide)</summary>

```toml
[keybindings]
# Bind "Shift+i" to "Seek forward 10 seconds"
"Shift+i" = "seek +10s"
```

To disable a default keybinding, set its command to `noop`:

```toml
# Use "Shift+q" to quit instead of the default "q"
[keybindings]
"Shift+q" = "quit"
"q" = "noop"
```

</details>

### Proxy
Resonance will respect system proxy settings defined via the `http_proxy`
environment variable.

```sh
# In sh-like shells
http_proxy="http://foo.bar:4444" resonance --legacy-ui
```

### Theming
[Theme generator](https://ncspot-theme-generator.vaa.red/) by [@vaarad](https://github.com/vaared).

The color palette can be modified in the configuration. For instance, to have
Resonance match Spotify's official client, you can add the following entries to
the configuration file:

```toml
[theme]
background = "black"
primary = "light white"
secondary = "light black"
title = "green"
playing = "green"
playing_selected = "light green"
playing_bg = "black"
highlight = "light white"
highlight_bg = "#484848"
error = "light white"
error_bg = "red"
statusbar = "black"
statusbar_progress = "green"
statusbar_bg = "green"
cmdline = "light white"
cmdline_bg = "black"
search_match = "light red"
```

More examples can be found in [this pull request](https://github.com/hrkfdn/ncspot/pull/40).

### Track Formatting
It's possible to customize how tracks are shown in Queue/Library views and the
statusbar, whereas `statusbar_format` will hold the statusbar formatting and
`[track_format]` the formatting for tracks in list views.
If you don't define `center` for example, the default value will be used.
Available options for tracks: `%artists`, `%artist`, `%title`, `%album`, `%saved`,
`%duration`.
`%artists` will show all contributing artists, while `%artist` only shows the first listed artist.

Default configuration:

```toml
statusbar_format = "%artists - %title"

[track_format]
left = "%artists - %title"
center = "%album"
right = "%saved %duration"
```

<details>
  <summary>Examples: (Click to show/hide)</summary>

Example 1 - Show only album name and track name after it:

```toml
[track_format]
left = "%album"
center = "%title"
right = ""
```

Example 2 - Show track title before artists, and don't show album at all:

```toml
[track_format]
left = "%title - %artists"
center = ""
```

Example 3 - Show everything as default, but hide saved status and track length:

```toml
[track_format]
right = ""
```

Example 4 - Show everything as default, except show title before artists:

```toml
[track_format]
left = "%title - %artists"
```

Example 5 - Show saved status and duration first, followed by track title and artists, with the album last:

```toml
[track_format]
left = "|%saved| %duration | %title - %artists"
center = ""
right = "%album"
```

</details>

### Notification Formatting
Resonance also supports customizing the way notifications are displayed
(which appear when compiled with the `notify` feature and `notify = true`).
The title and body of the notification can be set, with `title` and `body`, or the default will be used.
The formatting options are the same as those for [track formatting](#track-formatting) (`%artists`, `%title`, etc)

Default configuration:

```toml
[notification_format]
title = "%title"
body = "%artists"
```

### Cover Drawing
When compiled with the `cover` feature, Resonance can draw the album art of the
current track in a dedicated view (`:focus cover` or <kbd>F8</kbd> by default)
using terminal image protocols supported by your terminal, such as Kitty,
iTerm2, or Sixel. If no supported graphics protocol is detected, Resonance
falls back to colored terminal blocks.

By default, cover art scales to fit the available terminal view. To limit
scaling beyond the image's native resolution, use the config key
`cover_max_scale`:

```toml
cover_max_scale = 2
```

