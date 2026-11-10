// Learns a topic from its Yes and No photos away from the page, so the app stays responsive.
import { learnScores, type LearnInput } from './learn';

self.onmessage = (e: MessageEvent<{ id: number; input: LearnInput }>) => {
  const { id, input } = e.data;
  const scores = learnScores(input);
  (self as unknown as Worker).postMessage({ id, scores }, [scores.buffer]);
};
