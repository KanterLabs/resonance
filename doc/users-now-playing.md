[User guide](users.md)

### Now Playing
The visualizer shows the spectrum of the audio actually playing, read from the
playback sink and split into bands by frequency. When nothing is coming through
it falls back to an animated band so the view still has some life in it, and
`visualizer_fps = 0` turns it off entirely. `visualizer_style` picks the shape it
takes: `bars` (the default), `mirror` for bars with a reflection under them,
`wave` for a single line tracing the band, or `vu` for one horizontal meter with
a peak marker.

The card is tinted with the album cover's own colour, which `cover_accent = false`
turns off, and it brightens in time with the beat, which `beat_pulse = false`
turns off. The cover itself pulses along with it. Once enough beats have been
heard to be sure of the tempo, the card's status chip also shows it in BPM, and
the fallback band pumps along at that tempo instead of a made up one.

The progress bar is drawn as the track's own waveform: while a track plays, how
loud it is at each point is written down, so the bar shows the shape of the music
with the part you have heard lit up. The first listen fills the shape in behind
the playhead and every later one has it ready up front. Shapes are kept in
`waveforms.db` in the cache directory, and `waveform = false` goes back to a
plain bar.

A title, artist or album too long for the card scrolls rather than being cut off
with an ellipsis, the text fades up out of the background when a new track
starts, the cover fades in as soon as it has been decoded, and the progress bar
shades from dim at the start of the track up to full at the playhead.
`visualizer_fps = 0` turns the scrolling and the fades off along with the
visualizer. On a theme that leaves the background to the terminal there is no
colour to fade out of, so the fades use the terminal's dim attribute instead.

The album's colour is not confined to this screen: the statusbar's progress bar
and the playing row in every list take the same tint, and it crossfades from one
album's colour to the next rather than snapping.

The card is clickable: the transport buttons, the progress bar, the repeat and
shuffle toggles and the volume meter all respond to a click, and scrolling over
the volume meter or progress bar adjusts them. Cover art is drawn beside the
metadata when the terminal is wide enough and Resonance was built with the
`album_art` feature (on by default). It is drawn with quadrant block glyphs, so
a font that carries them (most monospace fonts do) gives the most detail.

Click **Radio** or press <kbd>Shift</kbd>+<kbd>R</kbd> to start a radio from the
currently playing song. It keeps playing from the same position while similar
songs load into the queue immediately after it. Starting radio clears the previous
queue, including explicitly queued songs, and keeps only the playing song. Songs
queued manually after radio starts still play before automatic recommendations.
Radio is available for Spotify songs; local files and podcast episodes cannot
seed a station.

Radio automatically refills before its queue runs out. It never automatically
replays a song already played or attempted in this terminal session, even after
queue edits or starting another station. A new duplicate explicitly queued by
you remains playable. Repeat settings do not loop a running station. Stop with
<kbd>Shift</kbd>+<kbd>S</kbd> or clear the queue to end it. If the cache has no
unheard candidates, the station remains active with **RADIO WAITING**, retries
with backoff, and resumes when more metadata is available.

Radio ranks from the local track cache and listening history first. Artist, genre,
and catalog metadata is enriched in the background when it is available; genre
metadata is opportunistic. This enrichment does not use Spotify's recommendations
endpoint, and selecting a track does not trigger an on-demand recommendation
request. Manual early skips are learned as preference feedback separately from
playback or stream errors, which are recorded as errors rather than dislikes.
Mood and audio-feature signals are not part of the current ranking.

Use <kbd>:</kbd><kbd>discovery</kbd> to choose how familiar or exploratory a local
station should be. The selector offers `0` (Familiar), `25`, `50` (Balanced), `75`,
and `100` (Explore); `:discovery 75` (or any number from 0 to 100) sets an exact
level directly. The animated dial next to Radio also supports clicks, the mouse
wheel, and left/right arrows after clicking to focus it. Clicking elsewhere
returns arrows to navigation. `visualizer_fps = 0` makes it static. The control
only changes radio candidate selection, so it leaves the current track and queue
alone. A small on-screen notice shows the selected label and percentage.

Use <kbd>:</kbd><kbd>radio-debug</kbd> to open the scrollable local diagnostics
report. The report is local and quick: it reads cached metadata and never logs in
or makes a network request. For a deterministic offline report, run:

```text
resonance radio-debug --seed URI_OR_ID --rng-seed 42 --limit 20 --discovery 50
```

To write a detailed replay log containing seeds, scores, rejection reasons,
timings, and cache statuses, use the same controls with `--debug`:

```text
resonance --debug /tmp/resonance-radio.log radio-debug --seed URI_OR_ID --rng-seed 42 --limit 20
```

Interactive radio saves the latest `radio-debug.json` report and `radio-replay.json` input snapshot are
kept in the cache directory shown by `resonance info`. Reproduce the selected order
from that immutable snapshot with:

```text
resonance radio-debug --replay /path/to/radio-replay.json
```

When the terminal is wide enough for both (about 100 columns), the queue sits in
an **Up Next** panel beside the card. It lists the tracks in the order they
will play, shuffle included: the eight tracks before the playing one, the
playing one (marked ▸), then the eight after it. A shorter panel keeps the
playing track in the middle. Click a track to play it. <kbd>↑</kbd>/<kbd>↓</kbd> (or
<kbd>j</kbd>/<kbd>k</kbd>) move a cursor through the list, <kbd>Enter</kbd>
plays the track under it and <kbd>d</kbd> takes it out of the queue. The cursor
goes away again when the track changes. While it is out of sight,
<kbd>Enter</kbd> and <kbd>d</kbd> do what they always have here, pausing and
unsaving the playing track.

| Key                                         | Command                                              |
|---------------------------------------------|------------------------------------------------------|
| <kbd>/</kbd>                                 | Open quick search (see below).                       |
| <kbd>Shift</kbd>+<kbd>R</kbd>                 | Start radio from the currently playing song.         |
| <kbd>Ctrl</kbd>+<kbd>F</kbd>                 | Open quick search, from any view.                    |
| <kbd>1</kbd> - <kbd>4</kbd>                  | Pick the result with that number.                    |
| <kbd>Enter</kbd>                             | Pick the first result.                               |
| <kbd>1</kbd> / <kbd>2</kbd> (after picking)  | Play the result next / play it now.                  |
| <kbd>3</kbd> (after picking)                 | Play it now and queue similar tracks behind it.      |
| <kbd>Alt</kbd>+digit                         | Type a digit into the query instead of picking.      |
| <kbd>Escape</kbd>                            | Back to the query, or close quick search.            |

Quick search is bound to <kbd>/</kbd> here and to <kbd>Ctrl</kbd>+<kbd>F</kbd>
everywhere; it is also available as the `quicksearch` command, so it can be
rebound like any other. It runs a Spotify track search as you type and shows the top four
matches. Choosing and playing is always two keys: a digit picks the result it
numbers, then <kbd>1</kbd> queues it after the current track, <kbd>2</kbd>
plays it immediately, or <kbd>3</kbd> starts a radio from it: the track plays
at once and tracks like it fill the queue behind it. A digit only picks once there is a result to pick, so a
query can still start with a number; to type a digit after results are up, hold
<kbd>Alt</kbd>.

Results carry a small thumbnail of the album cover, drawn once the cover has been
fetched, and nothing shifts sideways while you wait for one.

Results appear before the network answers: matches from your saved library are
shown on the keystroke itself, and previous searches are remembered in
`searches.db` in the cache directory, so a repeated query needs no request at
all and a growing one keeps the previous prefix's results on screen instead of
blanking. Covers for the results are fetched in the background, so art for a
track you play is already on disk.

