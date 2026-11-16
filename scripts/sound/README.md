# Sound sourcing tools

The scripts that found, fetched and processed the files in sound-candidates/. Kept for the next round of sounds.

- `fs.py`, `fsinfo.py`: Freesound search (license filter: CC0 and CC BY only) and file details.
- `oga.py`, `wmc.py`, `sb.py`: OpenGameArt, Wikimedia Commons and SoundBible lookups.
- `spec.py` writes `spec.json`: every candidate with its source, license, trim, layers and variants.
- `fetch.py`, `fetch2.py`: download the sources named in spec.json (Freesound HQ previews, Kenney packs, incompetech).
- `process.mjs`: decode, mix layers, trim, fade, loudness-normalise (BS.1770, -16 LUFS effects, -20 LUFS music, -1 dBFS peak) and encode Ogg Opus (64 kbps mono effects, 80 kbps stereo music) in headless Chromium through WebCodecs, with a small Ogg muxer. No ffmpeg needed.
- `build.py`: writes sound-candidates/manifest.json, CREDITS.md and listen.html.

They were run from a scratch folder with downloads kept outside the repo; paths at the top of each script point there and need adjusting before reuse.
