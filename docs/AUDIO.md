# Audio

Sounds are recordings and music is real music, made by people (CC0 and CC BY, listed in `CREDITS.md` and in the
game: title screen > Credits, and Menu > Credits in a game). `src/client/audio.ts` is the entry point; the parts are
in `src/client/sound/`:

| File | What |
|---|---|
| `sound/library.ts` | data: which file(s) each sound plays and at what gain (the mix), the music tracks of each mood |
| `sound/bank.ts` | loads and decodes the effect files in the background after the first click |
| `sound/spatial.ts` | pure: zoom and on-screen gating, the gunfire bed level, variant picks, per-play variation |
| `sound/battle.ts` | read-only: turns the fighting in the state (effects, deaths, tank fire, launches) into cues at map places |
| `sound/music.ts` | pure mood machine, and the player that streams and crossfades the tracks |
| `sound/credits.gen.ts`, `sound/creditsView.ts` | the credits (generated, one per recording a layered file mixes) and their DOM |
| `sound/loudness.gen.ts` | each file's measured loudness (generated): quieter variant takes are evened out, by 4 dB at most |
| `scripts/audio/import.ts` | copies the picked files from the sound-candidates folder, makes the AAC copies, writes the credits |

A sound without a file in `library.ts`, or whose file is not loaded yet (or failed), plays its synthesized version
(the recipes in `audio.ts`), so nothing is ever silent and nothing throws. Without an AudioContext (Node tests, old
browsers, blocked audio) the manager is a silent no-op; its rate limiting still runs, which is how the tests check it.

## Adding or swapping a file

Each sound maps to a list of variant takes in `SFX` (`sound/library.ts`); music moods map to lists of tracks in
`MUSIC`. Adding a variant or swapping a file is one line there, then:

```sh
git fetch origin sound-candidates
mkdir -p /tmp/cand && git archive origin/sound-candidates sound-candidates | tar x -C /tmp/cand
npx vite-node scripts/audio/import.ts /tmp/cand/sound-candidates
```

It copies the files to `public/audio/sfx/<id>.ogg` and `public/audio/music/<id>.ogg` (ids as in the candidates'
`manifest.json`; variant takes are `<id>-v2`, `-v3` and so on, `variantOf` in the manifest). An effect is replaced when
its source changed; a music track only when the new one is no bigger. Music above 88 kbps is re-encoded to 80 kbps
Opus. It remakes the AAC `.m4a` copy of each changed file, removes files no longer used and rebuilds `CREDITS.md`,
`sound/credits.gen.ts` and `sound/loudness.gen.ts`. Round 2 (2026-11-15): every picked effect has 2 to 4 more takes
(58 in all), the six sounds that were still synthesized and the atom bomb got new files, and every effect has short
fades at both ends.

## Formats

Files are Ogg Opus with an AAC (`.m4a`) copy. Safari plays Ogg only from 18.4 (macOS 15.4, iOS 18.4) and its Web
Audio decoding of Ogg Opus is not reliable, so the browser's `canPlayType('audio/ogg; codecs="opus"')` picks the order:
Ogg first where it says yes, AAC first otherwise; a file that fails in one format is tried in the other. Firefox on
Linux may lack AAC, which is why Ogg stays the first choice where it plays. Paths are relative (`audio/...`), so they
work with vite `base: './'` on the Pages subpath and at the root on the server; the server answers byte ranges,
which Safari needs to stream `<audio>`. The single-file copy of the page (the playable artifact) has no audio files:
there the effects stay synthesized and there is no music.

## Loading

- Nothing loads before the first click or key (the AudioContext needs a gesture anyway). Then the effects load in
  the background, four at a time: the first take of every sound (most used first), then the other takes (about
  1.9 MB in Ogg for all 86 files). The game never waits for them; a take not loaded yet is skipped for one that is.
- Music streams with an `<audio>` element through a `MediaElementAudioSourceNode` (no decoded minutes in memory).
  A track loads only when it is about to play.

## Every play varies

- a random variant take, never the same one twice in a row when there are several;
- a playback rate within the sound's `pitch` spread (4 to 7 % for effects, less for musical alerts, none for the
  stings), moved a clear step from the last play, so even one take never repeats exactly;
- a gain within +-2 dB, with quieter or louder takes evened out against the first take (4 dB at most);
- the gunfire bed starts at a random place in its loop.

## Not everything at once

Sounds at a map place (`SOUND_INFO[id].spatial`) are heard only when the place is on screen or just off its edge, and
their volume follows the camera zoom (screen px per tile, `camera.ts`: from 0.8 x the whole-map fit, about 0.7 to 2.3
by map size, up to 40; units are drawn as sprites from 5):

| Tier | Sounds | Full at zoom | Silent at or below | Past the screen edge |
|---|---|---|---|---|
| small | shots, small blasts, tank shots | 6 | 2.5 | 8 % of the view |
| medium | tank kills, plane crashes, missile launches, sonar, barrages | 4.5 | 1.6 | 12 % |
| big | atom bomb, big blasts, ships sinking | 3 | never: 22 % of full from zoom 1 | 25 % |

The fade is even in log(zoom). Pan follows the screen x. Your nation's news (under attack, capital and city lost,
alliances, research, victory, defeat) and the UI are not positional and always play; an atom bomb on your own land
plays at 60 % or more wherever the camera is. The capture tick plays for your own captures anywhere and for others'
only on screen, close up.

Where the fighting sounds come from (`sound/battle.ts`, with the fog of war applied):

| In the state | Sound |
|---|---|
| `shot` effect from a warship / a submarine / anti-air | `shot` (cannon) / `sonarPing` / a soft `shot` |
| `barrage` effect | `bombard` |
| `explosion` of 4 tiles and up (rockets, bomb runs) | `explosionBig` |
| the sim's kill blast (1.5 tiles) where a unit died (`fx/deaths.ts`) | `planeCrash`, `shipSunk`, a small `explosion` for a missile |
| a kill blast with no death (a hit) | `explosion` (soft) |
| a tank division destroyed | `tankDestroyed` (`unitLost` when it was yours) |
| a tank division in a fight (a spearhead, or next to land of a nation it fights) | `tankShot` about every 2.5 s |
| a rocket or atom bomb appears | `missileLaunch` at its silo |
| `nuke` effect | `atomBomb` |

The front gunfire bed is one looping voice: its level follows the captures and the tanks firing on screen (decaying
over about 2.5 s), close up only (silent at zoom 2.5 and below, full from 5), smoothed, and it stops after 5 quiet
seconds. With a camera, the event-side copies of fighting sounds (strike reports, units lost) stay silent because
the cues above already play them where they happen.

## Limits and the mix

- Per-sound minimum gaps in real time (`gapMs`), so x4 game speed is not 4x noisier.
- A per-sound cap on copies at once (`cap`, default 2): a big battle can't stack 20 explosions.
- A global voice cap: cosmetic sounds stop at 8 voices, everything else at 14; critical ones always play.
- A soft compressor on the master bus (threshold -12 dB, ratio 10), so a busy battle can't clip.
- Gains in `SFX` (files are levelled to about -16 LUFS, music to -20): the atom bomb is the loudest; big blasts and
  alerts next; combat under the music when zoomed out (the zoom fade) and forward when zoomed in; UI clicks soft.
- Settings: Menu > Sound has Master, Effects and Music sliders and Sound on / Muted.

## Music

Moods: menu (title screen), peace, war (your nation fought another nation within 30 s) and battle (heavy fighting:
tension 0.6 or more). Tension is the largest of `setTension()`, attacks on you (0.3 each) plus your attacks on nations
(0.12 each), a decaying alarm (half-life 20 s) from under-attack, capital-lost and incoming-missile events, and the
fighting on screen. Rising needs the mood to hold 2.5 s; calming down needs 25 s and at least 30 s in the mood;
battle stays down to tension 0.35. Tracks crossfade over 3.5 s, rotate within a mood (never the last one again) and
hand over near their end. Victory and defeat stings stop the music; it comes back softly a few seconds after. The
atom bomb and alerts duck the music for a moment. The music pauses while the tab is hidden.

Music is on by default (0.5). Settings are saved in `localStorage['borderfall.audio.v2']`; version 1 settings
(`borderfall.audio.v1`, when music was a synth pad that was off by default) are migrated once: master, effects and
mute are kept, music comes on at the default unless it had been turned up.

## API

```ts
const audio = new AudioManager();       // reads saved settings; no AudioContext yet
audio.unlockOnGesture(window);          // unlock() on clicks and keys: context, effect loading, music
audio.setVolume(master, sfx, music);    // each 0..1, undefined keeps one; saved
audio.setMuted(true);                   // saved
audio.play('uiClick', { pan, volume }); // -> boolean (false: rate-limited, capped or muted)
audio.update(state, camera);            // per frame in a game: events, effects, fighting, bed, countdown, music
audio.skipTo(state);                    // an online catch-up: all of it is history
audio.onGameEvent(e, humanId, pan?);    // the plain event mapping (soundForEvent)
audio.onEffect(fx, humanId, pan?);      // the plain effect mapping (soundForEffect)
audio.musicMood; audio.musicTrack; audio.sampleStats; audio.gunfireLevel; // for checks
audio.dispose();
```

## Verification

- `tests/audio.test.ts`: every method without throws, every `GameEventKind`, the event mapping, rate limits and the
  voice cap with a fake clock, persistence, `update()` on a real game state.
- `tests/sound.test.ts`: variant picks (no immediate repeat), per-play variation, zoom and on-screen gating, the
  per-sound cap, `update()` hearing a blast close up but not off screen and a shot close up but not far out, the
  music mood machine (hysteresis, no flip-flop, track rotation), the settings migration, that every file in the
  table exists in both formats, and the server's byte ranges.

## Map effects

The battle effects (`src/client/fx/`) are drawn, not heard, and have their own switch: Menu > Map > "Map effects
on / off" (saved in `localStorage` as `borderfall.fx.v1`). They are read-only like the sounds: the director reads
new events, effects, dead units and vanished forts from the state each frame and never writes to it.

| Trigger | Effect | Gap (ms) | Max at once |
|---|---|---|---|
| `capture` effect on a tile now yours (zoom 2+) | soft ring | 90 | 8 |
| `buildingCaptured` of a City, yours | gold pulse (the HUD's "+City" floater names it) / red pulse + "City lost" | 300 | 3 |
| `capitalLost` concerning you | three-ring pulse + "Capital taken" / "Capital lost" | 1000 | 2 |
| 1.5-tile `explosion` where a ship died | splash rings, droplets, sinking fragments | 150 | 4 |
| 1.5-tile `explosion` where a plane died | ember + smoke puff | 150 | 4 |
| `barrage` effect | dust that settles over the disc | 200 | 4 |
| a fort disappears (not captured) | ring of heavy dust + debris | 300 | 3 |
| `explosion` 4+ tiles (rocket, bombs) | one shockwave ring | 120 | 4 |
| `nuke` effect | two wide rings; a 6 px shake for 0.6 s when within ~1.5 views of the camera | 300 | 2 |

The pool holds 40 effects; cosmetic ones (ripples, barrage dust) stop at 75% and are the first to be replaced.
Nothing is shown for things off screen, older than 1.5 s, or after a jump of more than 3 s (online catch-up).
`prefers-reduced-motion` keeps the effects and drops the shake.
