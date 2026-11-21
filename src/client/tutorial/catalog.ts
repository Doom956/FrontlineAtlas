// Every tutorial, the basics first: the Tutorials menu lists them in this order.
import type { TutorialChapterId } from './engine';
import type { TutorialChapter } from './engine';
import { CHAPTERS } from './chapters';
import { doneChapters } from './engine';
import { QUICK_TUTORIAL } from './steps';

export const ALL_TUTORIALS: TutorialChapter[] = [QUICK_TUTORIAL, ...CHAPTERS];

export function chapterById(id: string): TutorialChapter | undefined {
  return ALL_TUTORIALS.find((c) => c.id === id);
}

/** True when every tutorial (the basics and each chapter) was finished at least once. */
export function allTutorialsDone(done: readonly TutorialChapterId[] = doneChapters()): boolean {
  return ALL_TUTORIALS.every((c) => done.includes(c.id));
}
