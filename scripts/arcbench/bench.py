"""Compare energy/tempo sources for arcs against full-listen fingerprints.

Sources:
  deezer_preview  - Deezer 30 s preview, run through a Python port of Resonance's audio tap
  reccobeats      - ReccoBeats audio-features energy (Spotify-style)
  deezer_gain     - Deezer's track gain (dB), louder master = higher energy
  heard           - waveform loudness cache (what arcs use today when no fingerprint)
  artist_loo      - leave-one-out mean of other fingerprints by the same artist (today's estimate)
"""
import json, subprocess, time, urllib.request, urllib.parse, re, sys, os
import numpy as np

D = "/tmp/arcbench"
UA = {"User-Agent": "resonance-arcbench/0.1"}


def get_json(url):
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=15) as r:
                data = json.load(r)
            if isinstance(data, dict) and data.get("error", {}).get("code") == 4:
                time.sleep(6); continue
            return data
        except Exception as e:
            time.sleep(2)
    return None


def norm(s):
    s = s.lower()
    s = re.sub(r"\(.*?\)|\[.*?\]| - .*$|feat\..*$", "", s)
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


# ---------- audio tap port (src/audio_tap.rs + fingerprint.rs) ----------
SR, WINDOW, FLOOR_DB = 44100, 1024, -62.0
LOW_HZ, HIGH_HZ, BANDS = 40.0, 15000.0, 16
BASS_HZ, SENS, BFLOOR, EMEM = 160.0, 1.5, 1e-5, 1.5
REFRACT, TMEM, TMIN = 0.22, 16, 6
HANN = 0.5 * (1 - np.cos(2 * np.pi * np.arange(WINDOW) / WINDOW))


def fold(t):
    while t < 70: t *= 2
    while t >= 140: t /= 2
    return t


def level(win):
    rms = np.sqrt(np.mean(win.astype(np.float64) ** 2))
    db = 20 * np.log10(max(rms, 1e-9))
    return float(np.clip((db - FLOOR_DB) / -FLOOR_DB, 0, 1))


def bands(win):
    mags = np.abs(np.fft.rfft(win * HANN))[: WINDOW // 2] * (2.0 / WINDOW)
    bin_hz = SR / WINDOW
    out = []
    for b in range(BANDS):
        edge = lambda i: LOW_HZ * (HIGH_HZ / LOW_HZ) ** (i / BANDS)
        first = max(int(np.floor(edge(b) / bin_hz)), 1)
        last = max(int(np.ceil(edge(b + 1) / bin_hz)), first + 1)
        peak = mags[first:min(last, len(mags))].max(initial=0.0)
        db = 20 * np.log10(max(peak, 1e-9))
        out.append(float(np.clip((db - FLOOR_DB) / -FLOOR_DB, 0, 1)))
    return out


def analyze(mono):
    """Replays mono audio through the tap: 1024-frame packets, a sample every 100 ms."""
    coef = 1 - np.exp(-2 * np.pi * BASS_HZ / SR)
    filt, avg, last_beat, intervals = 0.0, 0.0, None, []
    levels, bright, dens, tempos = [], [], [], []
    packet = 1024
    next_sample = 0.1
    # The tap's one-pole low pass, applied to the whole clip at once (state carries across packets).
    kernel = coef * (1 - coef) ** np.arange(4096)
    size = 1 << int(np.ceil(np.log2(len(mono) + len(kernel))))
    bass = np.fft.irfft(np.fft.rfft(mono, size) * np.fft.rfft(kernel, size), size)[:len(mono)]
    for start in range(0, len(mono) - packet, packet):
        chunk = mono[start:start + packet]
        # one-pole low pass (vectorised via lfilter-equivalent loop is slow; approximate exactly)
        y = bass[start:start + packet]
        energy = float(np.mean(y * y))
        now = (start + packet) / SR
        if energy > BFLOOR and avg > 0 and energy > avg * SENS and (last_beat is None or now - last_beat >= REFRACT):
            if last_beat is not None:
                gap = now - last_beat
                if gap < 2.0:
                    intervals.append(gap); intervals[:] = intervals[-TMEM:]
            last_beat = now
        avg += min(packet / SR / EMEM, 1.0) * (energy - avg)
        while now >= next_sample and start + packet >= WINDOW:
            win = mono[start + packet - WINDOW:start + packet]
            levels.append(level(win))
            bs = bands(win)
            tot = sum(bs)
            if tot > 1e-7:
                bright.append(sum(i * v for i, v in enumerate(bs)) / tot / (BANDS - 1))
            dens.append(tot / BANDS)
            if len(intervals) >= TMIN:
                med = sorted(intervals)[len(intervals) // 2]
                if med > 0: tempos.append(fold(60 / med))
            next_sample += 0.1
    lv, dn = np.mean(levels), np.mean(dens)
    tempo, conf = None, 0.0
    if len(tempos) >= 20:
        med = float(np.median(tempos))
        conf = float(np.mean([abs(t - med) / med <= 0.06 for t in tempos]))
        if conf >= 0.5: tempo = med
    return {"energy": float(np.clip(0.6 * lv + 0.4 * dn, 0, 1)),
            "brightness": float(np.mean(bright)) if bright else 0.5,
            "dynamics": float(np.clip(np.std(levels) * 3, 0, 1)),
            "tempo": tempo, "tempo_conf": conf}


def decode(url):
    raw = subprocess.run(["ffmpeg", "-v", "quiet", "-i", url, "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"],
                         capture_output=True, timeout=60).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


# ---------- data ----------
def recco(ids):
    out = {}
    for i in range(0, len(ids), 40):
        d = get_json("https://api.reccobeats.com/v1/audio-features?ids=" + ",".join(ids[i:i + 40]))
        for item in (d or {}).get("content", []):
            sid = item["href"].rsplit("/", 1)[-1]
            out[sid] = item
        time.sleep(0.5)
    return out


def deezer(title, artist, isrc, duration_s):
    if isrc:
        d = get_json(f"https://api.deezer.com/track/isrc:{isrc}")
        if d and "id" in d and d.get("preview"):
            return d, "isrc"
    q = urllib.parse.quote(f"{title} {artist}")
    d = get_json(f"https://api.deezer.com/search?q={q}&limit=10")
    for hit in (d or {}).get("data", []):
        if norm(hit["title"]) == norm(title) and norm(hit["artist"]["name"]) == norm(artist) and (duration_s is None or abs(hit["duration"] - duration_s) <= 4):
            full = get_json(f"https://api.deezer.com/track/{hit['id']}")
            if full and full.get("preview"):
                return full, "search"
    return None, None


def run(rows, cache_name):
    path = f"{D}/{cache_name}"
    cache = json.load(open(path)) if os.path.exists(path) else {}
    ids = [r["id"] for r in rows if r["id"] not in cache]
    rb = recco(ids) if ids else {}
    for n, r in enumerate(rows):
        if r["id"] in cache:
            r.update(cache[r["id"]]); continue
        f = rb.get(r["id"])
        r["recco"] = {k: f[k] for k in ("energy", "tempo", "valence", "loudness", "danceability")} if f else None
        isrc = f.get("isrc") if f else None
        dz, how = deezer(r["title"], r["artist"], isrc, r.get("duration_s"))
        r["deezer"] = None
        if dz:
            pcm = decode(dz["preview"])
            r["deezer"] = {"match": how, "bpm": dz.get("bpm") or None, "gain": dz.get("gain"),
                           "preview": analyze(pcm) if len(pcm) > SR * 20 else None}
        cache[r["id"]] = {"recco": r["recco"], "deezer": r["deezer"]}
        print(f"{n+1}/{len(rows)} {r['title'][:30]:30} recco={'y' if f else '-'} deezer={how or '-'}", file=sys.stderr)
        time.sleep(0.25)
    json.dump(cache, open(path, "w"))
    return rows
