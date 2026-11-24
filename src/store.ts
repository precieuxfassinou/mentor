import { createEmptyCard, fsrs, generatorParameters, Rating, State, type Card, type Grade, type FSRS } from 'ts-fsrs';
import type { Guide } from './prompts';

export type TopicKind = 'note' | 'folder' | 'query';

export interface Topic {
  id: string;
  title: string;
  kind: TopicKind;
  /** Note path, folder path or the question itself. */
  ref: string;
  created: string;
  lastStudied?: string;
  /** Concepts met in lessons and quizzes, with the last result on each (0 to 1). */
  concepts: Record<string, number>;
  lessons: number;
  /** Teacher's guide prepared for the last lesson, reused next time. */
  guide?: Guide;
  guideAt?: string;
  /** Best score in the timed challenge. */
  bestChallenge?: number;
}

export interface StoredCard {
  id: string;
  topicId: string;
  front: string;
  back: string;
  concept: string;
  source: string;
  created: string;
  fsrs: Card;
}

export interface QuizRecord {
  topicId: string;
  date: string;
  score: number;
  total: number;
  /** Answers marked sure that turned out wrong: the misconceptions to fix first. */
  overconfident: number;
}

export interface MentorData {
  topics: Record<string, Topic>;
  cards: Record<string, StoredCard>;
  quizzes: QuizRecord[];
  reviewDays: Record<string, number>;
}

export const EMPTY_DATA: MentorData = { topics: {}, cards: {}, quizzes: [], reviewDays: {} };

const DECAY = 0.1542; // FSRS-6 default
const FACTOR = Math.pow(0.9, -1 / DECAY) - 1;

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const today = () => new Date().toISOString().slice(0, 10);

export function topicId(kind: TopicKind, ref: string): string {
  let h = 0;
  for (const ch of `${kind}:${ref.toLowerCase()}`) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return `${kind}-${(h >>> 0).toString(36)}`;
}

/** JSON keeps dates as strings: give ts-fsrs real dates back. */
export function revive(card: Card): Card {
  return { ...card, due: new Date(card.due), last_review: card.last_review ? new Date(card.last_review) : undefined };
}

export class Scheduler {
  private f: FSRS;
  constructor(retention: number) { this.f = fsrs(generatorParameters({ enable_fuzz: true, request_retention: retention })); }

  newCard(): Card { return createEmptyCard(new Date()); }

  /** Next interval for each answer, to show on the buttons. */
  preview(card: Card): Record<Grade, Date> {
    const p = this.f.repeat(revive(card), new Date());
    return { [Rating.Again]: p[Rating.Again].card.due, [Rating.Hard]: p[Rating.Hard].card.due, [Rating.Good]: p[Rating.Good].card.due, [Rating.Easy]: p[Rating.Easy].card.due };
  }

  grade(card: Card, g: Grade): Card { return this.f.next(revive(card), new Date(), g).card; }
}

/** Probability of recalling the card right now (FSRS forgetting curve). */
export function recall(card: Card, now = Date.now()): number | null {
  if (card.state === State.New || !card.last_review) return null;
  const t = Math.max(0, (now - new Date(card.last_review).getTime()) / 864e5);
  return Math.pow(1 + FACTOR * t / Math.max(card.stability, 0.01), -DECAY);
}

export function isDue(c: StoredCard, now = Date.now()): boolean { return new Date(c.fsrs.due).getTime() <= now; }

export interface Mastery { value: number | null; cards: number; due: number; fresh: number; lastQuiz?: QuizRecord }

/** Mastery of a topic: memory of its cards (FSRS) weighted with the last quiz result. */
export function mastery(d: MentorData, topic: Topic): Mastery {
  const cards = Object.values(d.cards).filter(c => c.topicId === topic.id);
  const rs = cards.map(c => recall(c.fsrs)).filter((r): r is number => r !== null);
  const due = cards.filter(c => isDue(c) && c.fsrs.state !== State.New).length;
  const fresh = cards.filter(c => c.fsrs.state === State.New).length;
  const quizzes = d.quizzes.filter(q => q.topicId === topic.id);
  const lastQuiz = quizzes[quizzes.length - 1];
  const memory = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;
  const quiz = lastQuiz ? lastQuiz.score / Math.max(lastQuiz.total, 1) : null;
  const value = memory !== null && quiz !== null ? 0.6 * memory + 0.4 * quiz : (memory ?? quiz);
  return { value, cards: cards.length, due, fresh, lastQuiz };
}

/** Today's review: due cards plus a limited number of new ones, topics interleaved. */
export function reviewQueue(d: MentorData, newPerDay: number, topicFilter?: string): StoredCard[] {
  const all = Object.values(d.cards).filter(c => !topicFilter || c.topicId === topicFilter);
  const due = all.filter(c => c.fsrs.state !== State.New && isDue(c)).sort((a, b) => new Date(a.fsrs.due).getTime() - new Date(b.fsrs.due).getTime());
  const fresh = all.filter(c => c.fsrs.state === State.New).sort((a, b) => a.created.localeCompare(b.created)).slice(0, Math.max(0, newPerDay - (d.reviewDays[`new:${today()}`] ?? 0)));
  return interleave([...due, ...fresh]);
}

/** Round-robin across topics: mixing subjects helps tell them apart (interleaving). */
export function interleave(cards: StoredCard[]): StoredCard[] {
  const groups = new Map<string, StoredCard[]>();
  for (const c of cards) { const g = groups.get(c.topicId) ?? []; g.push(c); groups.set(c.topicId, g); }
  const lists = [...groups.values()];
  const out: StoredCard[] = [];
  for (let i = 0; out.length < cards.length; i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return out;
}

/** When the next card comes back, and how many are due then (for the empty state). */
export function nextReview(d: MentorData): { at: Date; count: number } | null {
  const later = Object.values(d.cards).filter(c => c.fsrs.state !== State.New && !isDue(c)).map(c => new Date(c.fsrs.due));
  if (!later.length) return null;
  later.sort((a, b) => a.getTime() - b.getTime());
  const day = later[0].toDateString();
  return { at: later[0], count: later.filter(x => x.toDateString() === day).length };
}

export function streak(d: MentorData): number {
  let n = 0;
  const day = new Date();
  if (!d.reviewDays[today()]) day.setDate(day.getDate() - 1);
  for (;;) {
    const k = day.toISOString().slice(0, 10);
    if (!d.reviewDays[k]) return n;
    n++; day.setDate(day.getDate() - 1);
  }
}

export { Rating, State };
export type { Card, Grade };
