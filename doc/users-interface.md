[User guide](users.md)

## Retained Cursive interface

The following reference covers the retained Cursive interface. Start it explicitly with
`resonance --legacy-ui`; the `ncspot` executable alias invokes the same interface for scripts and
existing desktop integrations. Current Unix installations should use the OpenTUI workspace guide
linked above.

### Key Bindings
The keybindings listed below are configured by default. Additionally, if you
built Resonance with MPRIS support, you may be able to use media keys to control
playback depending on your desktop environment settings. Have a look at the
[configuration section](users-configuration.md#configuration) if you want to set custom bindings.

### Navigation
| Key               | Command                                                                       |
|-------------------|-------------------------------------------------------------------------------|
| <kbd>?</kbd>      | Show help screen.                                                             |
| <kbd>F1</kbd>     | Queue (See [specific commands](#queue)).                                      |
| <kbd>F2</kbd>     | Search.                                                                       |
| <kbd>F3</kbd>     | Library (See [specific commands](#library)).                                  |
| <kbd>F4</kbd>     | Now Playing.                                                                  |
| <kbd>F8</kbd>     | Album Art (if built with the `cover` feature).                                |
| <kbd>Ctrl</kbd>+<kbd>F</kbd> | Open quick search (See [Now Playing](users-now-playing.md#now-playing)).               |
| <kbd>/</kbd>      | Open a Vim-like search bar (See [specific commands](#vim-like-search-bar)).   |
| <kbd>:</kbd>      | Open a Vim-like command prompt (See [specific commands](users-commands.md#vim-like-commands)). |
| <kbd>Escape</kbd> | Close Vim-like search bar, command prompt, or Search screen.                  |
| <kbd>Q</kbd>      | Quit Resonance.                                                               |
| <kbd>g</kbd>      | Go to the top of the current view (Vim motion).                               |
| <kbd>G</kbd>      | Go to the bottom of the current view (Vim motion).                            |

### Playback
| Key                           | Command                                                        |
|-------------------------------|----------------------------------------------------------------|
| <kbd>Return</kbd>             | Play track or playlist.                                        |
| <kbd>Space</kbd>              | Queue track or playlist.                                       |
| <kbd>.</kbd>                  | Play the selected item after the currently playing track.      |
| <kbd>P</kbd>                  | Move to the currently playing track in the queue.              |
| <kbd>S</kbd>                  | Save the currently playing item to your library.               |
| <kbd>D</kbd>                  | Remove the currently playing item from your library.           |
| <kbd>Shift</kbd>+<kbd>P</kbd> | Toggle playback (i.e. Play/Pause).                             |
| <kbd>Shift</kbd>+<kbd>S</kbd> | Stop playback.                                                 |
| <kbd>Shift</kbd>+<kbd>U</kbd> | Update the library cache (tracks, artists, albums, playlists). |
| <kbd><</kbd>                  | Play the previous track.                                       |
| <kbd>></kbd>                  | Play the next track.                                           |
| <kbd>F</kbd>                  | Seek forward by 1 second.                                      |
| <kbd>Shift</kbd>+<kbd>F</kbd> | Seek forward by 10 seconds.                                    |
| <kbd>B</kbd>                  | Seek backward by 1 second.                                     |
| <kbd>Shift</kbd>+<kbd>B</kbd> | Seek backward by 10 seconds.                                   |
| <kbd>-</kbd>                  | Decrease volume by 1%.                                         |
| <kbd>+</kbd>                  | Increase volume by 1%.                                         |
| <kbd>[</kbd>                  | Decrease volume by 5%.                                         |
| <kbd>]</kbd>                  | Increase volume by 5%.                                         |
| <kbd>R</kbd>                  | Toggle _Repeat_ mode.                                          |
| <kbd>Z</kbd>                  | Toggle _Shuffle_ state.                                        |
| <kbd>Shift</kbd>+<kbd>C</kbd> | Cast to a TV or speaker (see [Casting](#casting)).             |

### Context Menus
| Key                           | Command                                                                                                   |
|-------------------------------|-----------------------------------------------------------------------------------------------------------|
| <kbd>O</kbd>                  | Open a detail view or context for the **selected item**.                                                  |
| <kbd>Shift</kbd>+<kbd>O</kbd> | Open a context menu for the **currently playing track**.                                                  |
| <kbd>A</kbd>                  | Open the **album view** for the selected item.                                                            |
| <kbd>Shift</kbd>+<kbd>A</kbd> | Open the **artist view** for the selected item.                                                           |
| <kbd>M</kbd>                  | Open the **recommendations view** for the **selected item**.                                              |
| <kbd>Shift</kbd>+<kbd>M</kbd> | Open the **recommendations view** for the **currently playing track**.                                    |
| <kbd>Ctrl</kbd>+<kbd>V</kbd>  | Open the context menu for a Spotify link in your clipboard (if built with the `share_clipboard` feature). |
| <kbd>Backspace</kbd>          | Close the current view.                                                                                   |

When pressing <kbd>O</kbd>:

- If the _selected item_ is **not** a track, it opens a detail view.
- If the _selected item_ **is** a track, it opens a context menu with:
  - "Artist(s)" (let's you show or (un)follow a track's artist(s))
  - "Show Album"
  - "Share" (if built with the `share_clipboard` feature)
  - "Add to playlist"
  - "Similar tracks"

### Sharing
(if built with the `share_clipboard` feature)

| Key                           | Command                                                                  |
|-------------------------------|--------------------------------------------------------------------------|
| <kbd>X</kbd>                  | Copy the URL to the **currently selected item** to the system clipboard. |
| <kbd>Shift</kbd>+<kbd>X</kbd> | Copy the URL to the **currently playing track** to the system clipboard. |

### Queue
| Key                          | Command                              |
|------------------------------|--------------------------------------|
| <kbd>C</kbd>                 | Clear the entire queue.              |
| <kbd>D</kbd>                 | Delete the currently selected track. |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> | Save the current queue.              |

### Now Playing

See [Now Playing](users-now-playing.md#now-playing).

### Statusbar
The statusbar is a small player of its own, two lines under a hairline rule:

```
 ▓▓▓▓  Say Why · Zach Bryan         ◀◀  ❚❚  ▶▶   1:16 ━━━━━━━●┄┄┄┄┄┄┄┄┄ 2:23
 ▓▓▓▓  With Heaven On Top           ▁▂▅▇█▇▅▃▂▁   next  Wait for Me   ⇄ ↻ 57%
```

The cover sits on the left beside the track (`statusbar_format`, or the title and
artists when that is unset) and its album. The transport buttons sit in the
middle with a live equalizer underneath them, and the right hand side holds the
seek bar, the next track in the queue, the shuffle and repeat toggles and the
volume. Every button, the seek bar and both toggles respond to a click;
scrolling over the seek bar seeks and scrolling over the volume changes it, and a
click anywhere else pauses or resumes. When the terminal narrows, the transport
goes first and then the cover, so the name and the seek bar keep their room.

Names that do not fit scroll rather than clip. The seek bar and equalizer take
the playing album's colour and brighten with the beat, which `beat_pulse = false`
turns off. Keeping them moving means the interface redraws a few times a second
whenever something is playing, wherever you are in the app; `visualizer_fps = 0`
stops that if you would rather it stayed still.

### Casting
<kbd>Shift</kbd>+<kbd>C</kbd> (or `:cast`) moves playback to another device:
a Roku TV, a speaker, a console, or anything else signed in to Spotify. Resonance
stays the remote. The queue, shuffle, repeat, the transport keys, seeking and
the volume all work as before, and the Now Playing screen and statusbar follow
what the device is playing.

The picker lists the Spotify Connect devices your account can see, plus the
Rokus on your network. Picking a Roku opens its Spotify app first and waits
for it to come online, so the TV does not need to be on the Spotify app
already. The Roku needs the Spotify app installed and signed in to the same
account. If the Roku refuses to open it, set **Settings > System >
Advanced system settings > Control by mobile apps > Network access** to
*Permissive* on the Roku: some Roku software limits what other devices on the
network may ask of it. Rokus are found by an SSDP search of the local network. If yours is
not found, for instance because the network drops multicast, list its address
in the config:

```toml
roku_hosts = ["10.0.0.41"]
```

While casting, the statusbar shows the device's name. Click it to pick another
device. `:cast stop`, or the first entry in the picker, brings playback back to
this machine, carrying on from the same point. If the device goes away (it is
turned off, or someone else starts playing on it), Resonance waits a few seconds
and then brings playback home, paused.

The device plays one track at a time, with Resonance's queue choosing what comes
next, so there can be a second of silence between tracks. The visualizer has no
audio to analyse while casting, so it falls back to its animated band. Casting
needs Spotify Premium, like Resonance itself.

### Lists
The playing row of any list — library, queue, search results — fills with the
album's colour as the track plays, so a glance at a list says how far through it
is. A row that is also the selected one keeps its usual highlight instead.

### Volume and seeking
Changing the volume or seeking with a key raises a panel in the middle of the
screen with the new value and a bar, which fades away about a second later. The
same numbers are in the statusbar; the panel is there for when you are not
reading it.

### Library
| Key          | Command                                 |
|--------------|-----------------------------------------|
| <kbd>D</kbd> | Delete the currently selected playlist. |

### Vim-Like Search Bar
| Key          | Command                     |
|--------------|-----------------------------|
| <kbd>n</kbd> | Previous search occurrence. |
| <kbd>N</kbd> | Next search occurrence.     |

### Vim-Like Commands

See [Vim-Like Commands](users-commands.md#vim-like-commands).

