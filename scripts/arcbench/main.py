"""Benchmark arc energy sources against full-listen fingerprints. See doc/deezer-previews.md.

Copy fingerprints.json, waveforms.db, tracks.db, playlists.db and radio-catalog.json from a
Resonance cache directory into /tmp/arcbench, then run main.py, score.py and report.py in turn.
Needs Python 3 with numpy, and ffmpeg. Previews are decoded by ffmpeg, whose stereo to mono
downmix reads about 3 dB hotter than the tap's (L+R)/2; that shifts every energy equally and
leaves the rankings the benchmark compares unchanged.
"""
import json, os, random, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bench import *

fp = json.load(open(f"{D}/fingerprints.json"))["entries"]
lib = {}
for t in json.load(open(f"{D}/tracks.db")): lib[t["uri"]] = t
for p in json.load(open(f"{D}/playlists.db")):
    for t in p.get("tracks") or []:
        if t.get("uri", "").startswith("spotify:track:"): lib[t["uri"]] = t
for t in json.load(open(f"{D}/radio-catalog.json"))["tracks"]: lib[t["uri"]] = t

def row(uri, t=None, f=None):
    if t:
        return {"id": uri.split(":")[-1], "uri": uri, "title": t["title"], "artist": t["artists"][0],
                "artists": t["artists"], "duration_s": t["duration"] / 1000, "fp": f}
    title, artist = f["song_key"][5:].split("\x1f")
    return {"id": uri.split(":")[-1], "uri": uri, "title": title, "artist": artist, "artists": [artist],
            "duration_s": None, "fp": f}

measured = [row(u, lib.get(u), f) for u, f in fp.items()]
print("fingerprinted", len(measured), "with library metadata", sum(r["duration_s"] is not None for r in measured))
run(measured, "cache_measured.json")
json.dump(measured, open(f"{D}/measured.json", "w"))

random.seed(7)
others = [u for u in lib if u not in fp]
sample = [row(u, lib[u]) for u in random.sample(others, min(200, len(others)))]
print("library sample", len(sample), "of", len(others))
run(sample, "cache_library.json")
json.dump(sample, open(f"{D}/library.json", "w"))
