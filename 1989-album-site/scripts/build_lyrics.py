from pathlib import Path
import json
import re
import shutil
import struct

PROJECT = Path(r"C:\Users\张志铭\Desktop\1989-album-site")
AUDIO = Path(r"C:\Users\张志铭\Documents\style.m4a")
TIMING = Path(r"C:\Users\张志铭\Documents\xwechat_files\wxid_iocqhyqzpum522_aad3\msg\file\2026-11\Code_20261105.txt")
ASSETS = PROJECT / "assets"
ASSETS.mkdir(parents=True, exist_ok=True)

# --- audio duration from the m4a/MP4 mvhd atom -----------------------------
raw = AUDIO.read_bytes()
pos = raw.find(b"mvhd")
duration = None
timescale = None
if pos >= 0:
    version = raw[pos + 4]
    if version == 1:
        timescale = struct.unpack(">I", raw[pos + 24:pos + 28])[0]
        duration = struct.unpack(">Q", raw[pos + 28:pos + 36])[0] / timescale
    else:
        timescale = struct.unpack(">I", raw[pos + 16:pos + 20])[0]
        duration = struct.unpack(">I", raw[pos + 20:pos + 24])[0] / timescale
print("duration", duration, "timescale", timescale)

# --- parse word timings ----------------------------------------------------
text = TIMING.read_text(encoding="utf-8")
line_re = re.compile(r"^\[(\d{2}):(\d{2})\.(\d{2})\](.*)$")
word_re = re.compile(r"<(\d{2}):(\d{2})\.(\d{2})>([^<]+)")


def seconds(m, s, cs):
    return int(m) * 60 + int(s) + int(cs) / 100


lines = []
for raw_line in text.splitlines():
    match = line_re.match(raw_line.strip())
    if not match:
        continue
    m, s, cs, body = match.groups()
    line_start = seconds(m, s, cs)
    words = []
    for wm, ws, wcs, word in word_re.findall(body):
        word = word.strip()
        if word:
            words.append({"text": word, "time": round(seconds(wm, ws, wcs), 3)})
    if words:
        lines.append({"time": round(line_start, 3), "words": words})

# The final sentence is split over two lines by the provided file; merge it so
# the ending does not flicker between two fragments.
merged = []
for line in lines:
    if merged and line["time"] - merged[-1]["words"][-1]["time"] < 0.16:
        merged[-1]["words"].extend(line["words"])
    else:
        merged.append(line)
lines = merged

for line in lines:
    line["time"] = min(line["words"][0]["time"], line["time"])

payload = {
    "title": "Style",
    "album": "1989 (Deluxe)",
    "artist": "Taylor Swift",
    "duration": round(duration, 3) if duration else None,
    "lines": lines,
}
(ASSETS / "lyrics.js").write_text(
    "// Word-level lyric timings, generated from the supplied timing sheet.\n"
    "window.STYLE_LYRICS = "
    + json.dumps(payload, ensure_ascii=False, indent=2)
    + ";\n",
    encoding="utf-8",
)

shutil.copy2(AUDIO, ASSETS / "style.m4a")
shutil.copy2(TIMING, ASSETS / "style-timing-source.txt")
print("lines", len(lines), "words", sum(len(l["words"]) for l in lines))
print("first", lines[0])
print("last", lines[-1])
print("lyrics.js", (ASSETS / "lyrics.js").stat().st_size, "audio", (ASSETS / "style.m4a").stat().st_size)
