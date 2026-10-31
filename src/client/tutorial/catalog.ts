// The tutorial's chapters as the menu and the game see them (content in chapters.ts). The three-step stub stays for
// engine tests that want a tiny chapter.
import { tutorialTile } from '../../sim/tutorialScenario';
import { CHAPTERS } from './chapters';
import type { TutorialChapter } from './engine';

/** Three steps on the Basics practice map: place the capital, start, set the attack share. */
export const STUB_CHAPTERS: TutorialChapter[] = [
  {
    id: 'basics',
    title: 'Basics',
    blurb: 'Expand, set your attack size, grow troops and gold.',
    minutes: 3,
    steps: [
      {
        id: 'spawn',
        label: 'Place your capital',
        text: 'Click a land tile to place your capital.',
        tile: (s) => tutorialTile(s, 'basics', 'home'),
        done: (_s, me) => me.spawned,
      },
      {
        id: 'start',
        label: 'Start the game',
        text: 'Press Start now to begin.',
        target: 'start-now',
        done: (s) => s.phase === 'playing',
      },
      {
        id: 'share',
        label: 'Set the attack size',
        text: 'Set ATTACK to 50% or more with the slider.',
        target: 'attack-share',
        done: (_s, _me, ui) => ui.attackShare >= 0.5,
      },
    ],
  },
];

export function tutorialChapters(): readonly TutorialChapter[] {
  return CHAPTERS;
}
