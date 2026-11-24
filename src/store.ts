import { DefaultScheduler, Rating, State, type DefaultSchedulerCard, type Grade } from 'ts-fsrs';
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

/** Memory state of a card as saved in data.json (plain JSON, independent of the ts-fsrs version). */
export interface Card {
  due: string;
  state: number;
  stability: number;
  difficulty: number;
  lastReview: string | null;
  reps: number;
  lapses: number;
  scheduledDays: number;
  learningStep: number;
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

type LibCard = DefaultSchedulerCard<'FSRS-6'>;
const STATUS = ['new', 'learning', 'review', 'relearning'] as const;
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const iso = (v: unknown): string | null => {
  if (v instanceof Date) return v.toISOString();
  if (typeof v !== 'string' || !v) return null;
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};

/** Reads a saved card, including the format of Mentor 1.0.0 (ts-fsrs 5 field names). */
export function normalizeCard(raw: unknown): Card {
  const c = (raw ?? {}) as Record<string, unknown>;
  return {
    due: iso(c.due) ?? iso(c.dueAt) ?? new Date().toISOString(),
    state: Math.min(3, Math.max(0, num(c.state))),
    stability: num(c.stability),
    difficulty: num(c.difficulty),
    lastReview: iso(c.lastReview) ?? iso(c.last_review) ?? iso(c.lastReviewAt),
    reps: num(c.reps),
    lapses: num(c.lapses),
    scheduledDays: num(c.scheduledDays, num(c.scheduled_days)),
    learningStep: num(c.learningStep, num(c.learning_steps)),
  };
}

function toLib(c: Card, id: string): LibCard {
  return {
    stability: c.stability, difficulty: c.difficulty, state: c.state as State, scheduleStatus: STATUS[c.state] ?? 'new',
    dueAt: new Date(c.due), lastReviewAt: c.lastReview ? new Date(c.lastReview) : null, cardId: id,
    reps: c.reps, lapses: c.lapses, scheduledDays: c.scheduledDays, learningStep: c.learningStep,
  } as LibCard;
}

function fromLib(c: LibCard): Card {
  return {
    due: new Date(c.dueAt).toISOString(), state: c.state, stability: c.stability, difficulty: c.difficulty,
    lastReview: c.lastReviewAt ? new Date(c.lastReviewAt).toISOString() : null,
    reps: c.reps, lapses: c.lapses, scheduledDays: c.scheduledDays, learningStep: c.learningStep,
  };
}

/** FSRS-6 scheduler (ts-fsrs). Created asynchronously: use Scheduler.create(). */
export class Scheduler {
  private constructor(private s: DefaultScheduler<'FSRS-6'>) {}

  static async create(retention: number): Promise<Scheduler> {
    return new Scheduler(await DefaultScheduler({ version: 'FSRS-6', desiredRetention: retention, enableFuzz: true }));
  }

  newCard(): Card { return fromLib(this.s.newCard({ now: new Date() })); }

  /** Next due date for each answer, to show on the buttons. */
  preview(card: Card): Record<Grade, Date> {
    const out = {} as Record<Grade, Date>;
    for (const item of this.s.preview({ card: toLib(card, 'preview'), now: new Date() })) out[item.grade] = new Date(item.card.dueAt);
    return out;
  }

  grade(card: Card, g: Grade): Card { return fromLib(this.s.review({ card: toLib(card, 'review'), grade: g, now: new Date() }).card); }
}

/** Probability of recalling the card right now (FSRS forgetting curve). */
export function recall(card: Card, now = Date.now()): number | null {
  if (card.state === State.New || !card.lastReview) return null;
  const t = Math.max(0, (now - new Date(card.lastReview).getTime()) / 864e5);
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
export type { Grade };
