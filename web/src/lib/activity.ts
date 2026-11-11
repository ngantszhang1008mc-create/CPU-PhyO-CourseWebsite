export const activityLabels = {
  signin: 'Signed in',
  registered: 'Registered',
  set: 'Opened problem set',
  question: 'Opened question',
  correct: 'Checked answer · correct',
  incorrect: 'Checked answer · incorrect',
  written: 'Checked written work',
  hint: 'Opened hint',
  solution: 'Opened worked solution',
  complete: 'Marked complete',
  incomplete: 'Cleared completion',
} as const;

export interface ActivityEntry {
  id: number;
  occurred: number;
  kind: keyof typeof activityLabels;
  title: string | null;
  number: number | null;
  hint: number | null;
}

export type PracticeAction = 'question' | 'check' | 'hint' | 'solution' | 'complete' | 'incomplete';
