# Audio

`src/client/audio.ts` makes every sound procedurally with the Web Audio API: oscillators, filtered noise and
envelopes. There are no audio files. The goal is a small, quiet soundscape that stays pleasant at x4 speed with
hundreds of nations:

- **Rate limits per sound** in real time (`SOUND_INFO[id].gapMs`), so x4 game speed does not make it 4x noisier.
- **A global voice cap**: cosmetic sounds stop at 8 voices playing at once, everything else at 14. Critical
  sounds (under attack, capital lost, atom bomb, victory, defeat) always play.
- **Only events that concern the human** make a sound, plus a few global ones (atom bombs, nations eliminated,
  the war beginning).
- **A soft compressor** on the master bus. The measured peak is ≤ 0.8 even when every sound plays at once at full
  volume (see Verification).
- **No AudioContext, no problem.** In Node, in old browsers or with audio blocked, the manager is a silent no-op that
  never throws. The rate limiting still runs, which is how the tests check it.

## API

```ts
import { AudioManager } from './audio';
import type { SoundId } from './audio';

const audio = new AudioManager();           // reads saved settings; does not create an AudioContext yet

audio.unlock();                             // call in a user gesture (autoplay policy): creates/resumes the context
audio.unlockOnGesture(window);              // or: calls unlock() on the first pointerdown/keydown; returns a remover

audio.setVolume(master, sfx, music);        // each 0..1, undefined keeps the current value; saved
audio.setMuted(true);                       // saved
audio.getSettings();                        // { master, sfx, music, muted }

audio.play('uiClick', { pan: -0.3, volume: 0.8 });   // -> boolean: false if rate-limited, capped or muted

audio.onGameEvent(event, humanId, screenPan?);       // -> SoundId | null (the sound played)
audio.onEffect(effect, humanId, screenPan?, mine?);  // -> SoundId | null
audio.setTension(0..1);                     // music bed mood; update() also raises it by itself

audio.update(state, camera?);               // per frame: drains new events/effects, countdown ticks, auto tension
audio.dispose();                            // stops everything, closes the context
```

Settings are saved in `localStorage['borderfall.audio.v1']`, and every access is wrapped in try/catch. Defaults:
master 0.6, sfx 0.8, **music 0 (off)**, not muted.

Constructor options, mostly for tests and checks: `{ context?, now?, storage?, createContext? }`. `context`
uses that context right away (for example an `OfflineAudioContext`), `now` injects a fake clock in ms, and
`storage: null` turns persistence off.

Pure helpers are also exported: `soundForEvent(e, humanId)`, `soundForEffect(e, screenPan, mine?)`,
`panFromScreenX(sx, viewW)`, `SoundLimiter`, `SOUND_IDS`, `SOUND_INFO`.

## Integration (HUD / main loop)

Nothing in the game calls the audio module yet. Wiring it in takes four small pieces.

### 1. Create it once and unlock it on the first gesture (`src/client/main.ts`, top level)

```ts
import { AudioManager } from './audio';

const audio = new AudioManager();
audio.unlockOnGesture(window); // the menu's "Start" click is enough
```

### 2. One call per frame (`src/client/main.ts`, `frame()`, after `runTicks`, human games only)

```ts
const cur = session;
if (cur && cur.human) audio.update(cur.state, cur.camera);
```

`update()` drains each new event and effect exactly once, using its own WeakSets, so it does not interfere with
the HUD's `seenEvents`. When it sees a new `GameState`, it treats everything already in it as history and plays
nothing for it. It also ticks the spawn countdown for the last 5 seconds and computes the music tension from
attacks on the human. The `Camera` already satisfies the `ScreenView` shape (`viewW`, `viewH`, `tileToScreen`),
so it gives stereo pan and the on-screen test. Explosions and shots only sound on screen (or within 15% of
its edge). Capture ticks only sound for the human's own captures.

Use `update()` **or** `onGameEvent`/`onEffect` (for example from `Hud.addLog`), not both. Both together would
not double the sounds, because the per-sound gap would drop the second one, but they would count events twice for
the tension.

### 3. Sounds for the player's own actions (`dispatch` in `src/client/main.ts`)

```ts
const r = applyAction(s.state, s.state.humanId, action);
if (r.ok) {
  if (action.type === 'build') audio.play('buildPlaced');
  else if (action.type === 'launchMissile') audio.play('missileLaunch'); // also covers a strike on neutral land (no event)
} else {
  audio.play('uiError', { volume: 0.7 });
}
```

Attacks need no hook here. The sim's `attackStarted` event already plays `attackLaunched`.

### 4. UI clicks and the settings panel (`src/client/hud.ts`)

```ts
// in the Hud constructor, on the HUD root
root.addEventListener('click', (e) => {
  if ((e.target as Element).closest('button')) audio.play('uiClick');
});
root.addEventListener('pointerover', (e) => {
  if ((e.target as Element).closest('button')) audio.play('uiHover'); // 70 ms gap built in
});

// settings sliders (0..100) and a mute toggle
masterSlider.oninput = () => audio.setVolume(+masterSlider.value / 100);
sfxSlider.oninput = () => audio.setVolume(undefined, +sfxSlider.value / 100);
musicSlider.oninput = () => audio.setVolume(undefined, undefined, +musicSlider.value / 100);
muteBox.onchange = () => audio.setMuted(muteBox.checked);
const st = audio.getSettings(); // initial slider positions
```

Pass the manager to the `Hud` (constructor argument or a setter), or export it from a small module. On "back to
menu", nothing needs to happen: the next `update()` with a new state resets its bookkeeping. Call `dispose()`
only if the whole app is torn down.

## Event → sound

"Human" means `e.players` includes `humanId`, and "first" means `e.players[0] === humanId`. Events that concern
other nations only are silent, except the global ones (`players: []`).

| GameEventKind | When | Sound |
|---|---|---|
| `info` | global "The war begins!" | `countdownGo` |
| `info` | anything else | (none) |
| `attackStarted` | first (our attack) | `attackLaunched` (softer for neutral land) |
| `underAttack` | human, message mentions a transport (watchtower) | `shipHorn` (raises tension) |
| `underAttack` | human | `underAttack` alert (raises tension) |
| `buildingDone` | first | `buildingDone` (city upgrades a bit louder) |
| `buildingLost` | first | `buildingLost` |
| `buildingCaptured` | a City, first / human; silent when far off screen | `cityTaken` / `cityLost` |
| `buildingCaptured` | first (we took it) / human (taken from us) | `buildingDone` (soft) / `buildingLost` |
| `researchDone` | human | `researchDone` |
| `allianceRequest` | human (asked to us) | `allianceRequest` chime |
| `allianceFormed` | human | `allianceFormed` (softer when renewed) |
| `allianceBroken` | human | `allianceBroken` |
| `allianceExpired` | human | `allianceExpired` |
| `eliminated` | first (we are out) | `defeat` |
| `eliminated` | global or human | `eliminated` (distant gong) |
| `capitalLost` | first (ours) / human (we took one) | `capitalLost` (raises tension) / `capitalTaken` |
| `nuke` | global (always) | `atomBomb` |
| `missile` | human, "launched" | `missileLaunch` (raises tension when aimed at us) |
| `missile` | human, strike report | `explosion` |
| `bombing` | human | `explosion` |
| `unitLost` | human, a ship sunk by a warship or a mine; silent when far off screen | `shipSunk` |
| `unitLost` | first / human (enemy unit lost to us) | `unitLost` / `explosion` (soft) |
| `tradeDelivered` | human | `tradeCoin` |
| `victory` | first | `victory` fanfare (if someone else wins, the `defeat` event follows) |
| `defeat` | human | `defeat` sting |

## Effect → sound

| Effect kind | When | Sound |
|---|---|---|
| `nuke` | always | `atomBomb` (deduplicated with the `nuke` event by the 1.5 s gap) |
| `explosion` | on screen | `explosion` (quieter for small radius, e.g. ships sunk) |
| `capture` | the human's own capture (`update()` checks the tile owner) | `capture` tick, very quiet, panned, max ~14/s |
| `shot` | on screen | `shot` (very soft) |

"Far off screen" means more than one view width or height beyond the screen edge (`update()` checks the event's
tile against the camera). Big news (nukes, your capital) plays wherever it happens.

Other sounds are not mapped to an event or effect. `uiClick`, `uiHover`, `uiError` and `buildPlaced` come from
the HUD and `dispatch`. `countdown` comes from `update()` during the spawn phase, at 5..1 seconds.

## Sounds

| Id | What it is | Gap (ms) | Priority |
|---|---|---|---|
| `uiClick` / `uiHover` | tiny sine blips | 40 / 70 | 0 |
| `uiError` | two low soft triangles | 250 | 1 |
| `buildPlaced` | wooden double knock | 80 | 1 |
| `buildingDone` | two-note chime | 350 | 1 |
| `buildingLost` | falling thud | 600 | 1 |
| `researchDone` | rising four-bell arpeggio over a soft fifth | 800 | 2 |
| `attackLaunched` | two soft brass notes + swish | 1200 | 1 |
| `capture` | very quiet random-pitch tick | 70 | 0 |
| `underAttack` | two-tone alert twice over a low hum | 4000 | 3 |
| `allianceRequest` | three-bell major chime | 1500 | 2 |
| `allianceFormed` / `allianceBroken` / `allianceExpired` | major arpeggio + pad / tritone drop / two falling bells | 1500 | 2/2/1 |
| `capitalLost` / `capitalTaken` | minor brass chord + boom / rising brass + drum | 3000 | 3/2 |
| `cityTaken` / `cityLost` | short rising bugle call + drum / falling call over a low drop | 700 | 2 |
| `shipSunk` | low hull crump, a wash of water, a few bubbles | 600 | 1 |
| `explosion` | filtered noise burst + sine thump | 110 | 1 |
| `atomBomb` | deep falling boom + long wobbling rumble (5 s) | 1500 | 3 |
| `missileLaunch` | band-passed noise whoosh | 500 | 1 |
| `shipHorn` | low detuned saw horn | 4000 | 2 |
| `tradeCoin` | two-note coin ping | 500 | 0 |
| `unitLost` | short falling blip | 800 | 1 |
| `eliminated` | distant gong | 2500 | 1 |
| `victory` / `defeat` | brass fanfare with drums / falling brass line over a drone | 5000 | 3 |
| `countdown` / `countdownGo` | spawn-phase ticks / "go" ping | 400 / 1000 | 2 |
| `shot` | faint noise tick | 120 | 0 |

## Music bed

The music bed is off by default (music volume 0). Raise the music slider above 0 to start it. It is a slow
generative pad: four chord voices, each made of two detuned oscillators, plus a sub drone, through a low-pass
filter with a slow LFO. The chord changes every 9 s in peace and every 6 s under tension. With tension above 0.5
it switches to a minor progression, and the filter, the drone and its tremolo rise with tension. Tension is the
largest of three values: `setTension()`, the attacks against the human (0.3 each), and a decaying alarm
(half-life 20 s) from under-attack, capital-lost and incoming-missile events. The context suspends while the tab
is hidden.

## Verification

- `tests/audio.test.ts` runs in Node (vitest), where there is no AudioContext. It covers:
  - construction and every method, without throws;
  - every `GameEventKind`, which a `Record` forces to stay complete;
  - the mapping of each event;
  - rate limits and the voice cap, with a fake clock;
  - persistence, including corrupt and throwing storage;
  - `update()` on a real game state.
- In Chromium through Playwright, a scratch page outside the repo bundles `audio.ts` with esbuild and runs three
  checks:
  - Each sound is rendered alone in an `OfflineAudioContext` at master = sfx = 1. Every sound has RMS > 0, and
    the highest peak is 0.72 (atom bomb).
  - Every sound plus 40 explosions and captures are fired within one second at full volume. The voice cap let 23
    through, and the peak was 0.78.
  - A live `AudioContext` ran with `state === 'running'`. Each sound was played through an `AnalyserNode`: RMS
    was > 0 for every sound and the peak was ≤ 0.55. The music bed measured RMS 0.03 at rest and 0.11 at
    tension 1.

  There were no console errors or warnings.

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
