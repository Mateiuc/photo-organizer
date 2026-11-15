// Progress of "reading photos": the one pass that looks at each photo once and makes everything the app keeps about
// its picture (see reader.ts). Duplicates and Clean up both show it.
export interface ReadRun {
  running: boolean;
  done: number;
  total: number;
  /** 'model': the AI is being downloaded or started. 'reading': photos are being looked at. */
  step?: 'model' | 'reading';
  /** Download of the Clean-up AI, in bytes. */
  model?: { loaded: number; total: number };
  current?: string;
  error?: string;
  startedAt?: number;
  /** A part that was left out of this run, and why. */
  note?: string;
}
export const idleRun = (): ReadRun => ({ running: false, done: 0, total: 0 });
