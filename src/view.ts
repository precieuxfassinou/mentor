import { ItemView, MarkdownRenderer, Menu, Notice, TFile, TFolder, WorkspaceLeaf, setIcon } from 'obsidian';
import type MentorPlugin from './main';
import {
  GRADE_SCHEMA, GRADE_SYSTEM, GUIDE_SCHEMA, QUIZ_SCHEMA, WRAP_SCHEMA, challengePrompt, explainPrompt, explainSystem, gradePrompt, guidePrompt, guideSystem,
  parseTutor, quizPrompt, quizSystem, tutorSystem, tutorTurn, wrapPrompt, wrapSystem,
  type Grade, type Guide, type LessonWrapUp, type QuizQuestion, type Turn,
} from './prompts';
import { formatSources, fromFolder, fromNote, fromQuery, type SourceSet } from './sources';
import { Rating, mastery, nextReview, reviewQueue, streak, today, type Grade as FsrsGrade, type StoredCard, type Topic } from './store';

export const VIEW_TYPE = 'mentor-view';

type CoreState = 'idle' | 'thinking' | 'ok' | 'partial' | 'wrong';
type Mode = 'lesson' | 'quiz' | 'challenge';
type QuizResult = { q: QuizQuestion; score: number; sure: number; answer: string };

const SVG = 'http://www.w3.org/2000/svg';
const CHALLENGE_SECONDS = 20;
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)} %`);
const avg = (l: number[]) => l.reduce((a, b) => a + b, 0) / Math.max(l.length, 1);
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

function fmtInterval(d: Date): string {
  const min = Math.round((d.getTime() - Date.now()) / 60000);
  if (min < 60) return `${Math.max(1, min)} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h`;
  const days = Math.round(h / 24);
  if (days < 31) return `${days} j`;
  const months = Math.round(days / 30);
  return months < 12 ? `${months} mois` : `${(days / 365).toFixed(1)} an`;
}

function fmtDay(d: Date): string {
  const diff = Math.round((new Date(d.toDateString()).getTime() - new Date(new Date().toDateString()).getTime()) / 864e5);
  if (diff <= 0) return 'plus tard aujourd’hui';
  if (diff === 1) return 'demain';
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}

function svg<K extends keyof SVGElementTagNameMap>(parent: Element, tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  parent.appendChild(el);
  return el;
}

/** Mentor's "core": a small reactor, echo of the Faceless home, that shows what Mentor is doing. */
function core(parent: HTMLElement, state: CoreState = 'idle', size = 40): { el: SVGSVGElement; set: (s: CoreState) => void } {
  const el = svg(parent, 'svg', { viewBox: '0 0 64 64', width: size, height: size, class: `mentor-core is-${state}`, 'aria-hidden': 'true' });
  const ticks = svg(el, 'g', { class: 'mc-ticks' });
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const r1 = i % 6 === 0 ? 25 : 27;
    svg(ticks, 'line', { x1: 32 + Math.cos(a) * r1, y1: 32 + Math.sin(a) * r1, x2: 32 + Math.cos(a) * 30, y2: 32 + Math.sin(a) * 30 });
  }
  svg(el, 'circle', { class: 'mc-ring', cx: 32, cy: 32, r: 19 });
  svg(el, 'circle', { class: 'mc-arc', cx: 32, cy: 32, r: 19, pathLength: 100 });
  svg(el, 'circle', { class: 'mc-core', cx: 32, cy: 32, r: 7 });
  return { el, set: (s) => el.setAttribute('class', `mentor-core is-${s}`) };
}

/** Mastery ring, the same gauge language as the Faceless home. */
function ring(parent: HTMLElement, value: number | null, size = 44, label?: string): HTMLElement {
  const box = parent.createDiv({ cls: 'mentor-ring' });
  box.setCssStyles({ width: `${size}px`, height: `${size}px` });
  const s = svg(box, 'svg', { viewBox: '0 0 44 44', width: size, height: size, 'aria-hidden': 'true' });
  svg(s, 'circle', { class: 'mr-track', cx: 22, cy: 22, r: 18 });
  const arc = svg(s, 'circle', { class: 'mr-fill', cx: 22, cy: 22, r: 18, pathLength: 100 });
  arc.setAttribute('stroke-dasharray', `${Math.round((value ?? 0) * 100)} 100`);
  if (value !== null && value < 0.5) arc.classList.add('is-low');
  box.createDiv({ cls: 'mentor-ring-v', text: label ?? (value === null ? '—' : String(Math.round(value * 100))) });
  box.setAttr('aria-label', `Maîtrise ${pct(value)}`);
  return box;
}

/** Number that rolls up to its new value. */
function countTo(el: HTMLElement, from: number, to: number, ms = 700) {
  if (reducedMotion() || from === to) { el.setText(String(to)); return; }
  const start = performance.now();
  const step = (t: number) => {
    const k = Math.min(1, (t - start) / ms);
    const e = 1 - Math.pow(1 - k, 4);
    el.setText(String(Math.round(from + (to - from) * e)));
    if (k < 1) window.requestAnimationFrame(step);
  };
  window.requestAnimationFrame(step);
}

/** Short burst of HUD ticks from a point: the celebration of a good result. */
function burst(parent: HTMLElement, strong = false) {
  if (reducedMotion()) return;
  const layer = parent.createDiv({ cls: 'mentor-burst', attr: { 'aria-hidden': 'true' } });
  const n = strong ? 36 : 18;
  for (let i = 0; i < n; i++) {
    const p = layer.createDiv({ cls: `mentor-spark${i % 5 === 0 ? ' is-amber' : ''}` });
    const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
    const d = (strong ? 90 : 60) + Math.random() * (strong ? 90 : 50);
    p.setCssStyles({ '--dx': `${Math.cos(a) * d}px`, '--dy': `${Math.sin(a) * d}px`, '--rot': `${(a * 180) / Math.PI + 90}deg`, animationDelay: `${Math.random() * 80}ms` } as Partial<CSSStyleDeclaration>);
  }
  window.setTimeout(() => layer.remove(), 1400);
}

export class MentorView extends ItemView {
  private abort: AbortController | null = null;
  private timers: number[] = [];
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: MentorPlugin) { super(leaf); }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Mentor'; }
  getIcon() { return 'graduation-cap'; }

  async onOpen() { this.contentEl.addClass('mentor'); this.home(); }
  async onClose() { this.stopAll(); }

  private get data() { return this.plugin.data; }

  private stopAll() {
    this.abort?.abort();
    this.abort = null;
    for (const t of this.timers) { window.clearInterval(t); window.clearTimeout(t); }
    this.timers = [];
    if (this.keyHandler) { this.contentEl.removeEventListener('keydown', this.keyHandler); this.keyHandler = null; }
  }

  private onKeys(fn: (e: KeyboardEvent) => void) {
    if (this.keyHandler) this.contentEl.removeEventListener('keydown', this.keyHandler);
    this.keyHandler = fn;
    this.contentEl.addEventListener('keydown', fn);
    this.contentEl.tabIndex = -1;
  }

  private reset(screen: string): HTMLElement {
    this.stopAll();
    const root = this.contentEl;
    root.empty();
    root.dataset.screen = screen;
    return root.createDiv({ cls: 'mentor-screen' });
  }

  private md(el: HTMLElement, text: string, sourcePath = '') {
    el.empty();
    void MarkdownRenderer.render(this.app, text, el, sourcePath, this);
  }

  private btn(parent: HTMLElement, label: string, opts: { icon?: string; kind?: 'primary' | 'secondary' | 'ghost'; onClick: () => void; title?: string }): HTMLButtonElement {
    const b = parent.createEl('button', { cls: `mentor-btn is-${opts.kind ?? 'secondary'}` });
    if (opts.icon) setIcon(b.createSpan({ cls: 'mentor-btn-icon' }), opts.icon);
    b.createSpan({ text: label });
    if (opts.title) b.setAttr('title', opts.title);
    b.onclick = opts.onClick;
    return b;
  }

  private link(parent: HTMLElement, path: string) {
    const a = parent.createEl('a', { cls: 'internal-link mentor-src', text: path.replace(/\.md$/, '').split('/').pop() ?? path });
    a.setAttr('title', path);
    a.onclick = (e) => { e.preventDefault(); void this.app.workspace.openLinkText(path, '', 'tab'); };
    return a;
  }

  /** Waiting state: the core spins and seconds tick, so a long generation never looks frozen. */
  private waiting(parent: HTMLElement, title: string, detail?: string): { done: () => void; fail: (msg: string, retry?: () => void) => void } {
    const box = parent.createDiv({ cls: 'mentor-waiting' });
    const c = core(box, 'thinking', 72);
    const txt = box.createDiv({ cls: 'mentor-waiting-txt' });
    txt.createDiv({ cls: 'mentor-waiting-title', text: title });
    if (detail) txt.createDiv({ cls: 'mentor-waiting-detail', text: detail });
    const clock = txt.createDiv({ cls: 'mentor-waiting-clock', text: '0 s' });
    const start = Date.now();
    const id = window.setInterval(() => clock.setText(`${Math.round((Date.now() - start) / 1000)} s`), 1000);
    this.timers.push(id);
    return {
      done: () => { window.clearInterval(id); box.remove(); },
      fail: (msg, retry) => {
        window.clearInterval(id);
        c.set('wrong');
        txt.empty();
        txt.createDiv({ cls: 'mentor-waiting-title', text: 'Ça n’a pas marché' });
        txt.createDiv({ cls: 'mentor-waiting-detail', text: msg });
        const row = txt.createDiv({ cls: 'mentor-row' });
        if (retry) this.btn(row, 'Réessayer', { icon: 'rotate-ccw', kind: 'primary', onClick: retry });
        this.btn(row, 'Accueil', { icon: 'home', kind: 'ghost', onClick: () => this.home() });
      },
    };
  }

  private header(el: HTMLElement, title: string, sub?: string): HTMLElement {
    const bar = el.createDiv({ cls: 'mentor-bar' });
    const back = bar.createEl('button', { cls: 'mentor-icon-btn', attr: { 'aria-label': 'Retour à l’accueil' } });
    setIcon(back, 'arrow-left');
    back.onclick = () => this.home();
    const t = bar.createDiv({ cls: 'mentor-bar-title' });
    t.createDiv({ cls: 'mentor-bar-h', text: title });
    if (sub) t.createDiv({ cls: 'mentor-bar-sub', text: sub });
    return bar;
  }

  // ================================================================== home

  home() {
    const el = this.reset('home');
    const h = new Date().getHours();
    const head = el.createDiv({ cls: 'mentor-hero' });
    const words = head.createDiv({ cls: 'mentor-hero-words' });
    words.createDiv({ cls: 'mentor-brand', text: 'Mentor' });
    words.createEl('h1', { cls: 'mentor-title', text: h < 5 || h >= 18 ? 'Bonsoir. Qu’est-ce qu’on apprend ?' : 'Bonjour. Qu’est-ce qu’on apprend ?' });
    core(head, 'idle', 64).el.addClass('mentor-hero-core');

    const ask = el.createDiv({ cls: 'mentor-panel mentor-ask' });
    const input = ask.createEl('textarea', { cls: 'mentor-input', attr: { rows: '2', 'aria-label': 'Ce que tu veux apprendre', placeholder: 'Une notion de ton cours, une question… ex. « MapReduce », « différence entre REST et SOAP »' } });
    const row = ask.createDiv({ cls: 'mentor-row' });
    const go = (mode: Mode) => {
      const q = input.value.trim();
      if (!q) { input.focus(); input.addClass('is-shake'); window.setTimeout(() => input.removeClass('is-shake'), 450); return; }
      void this.startTopic({ kind: 'query', ref: q, title: q }, mode);
    };
    this.btn(row, 'Leçon guidée', { icon: 'presentation', kind: 'primary', onClick: () => go('lesson') });
    this.btn(row, 'Quiz', { icon: 'list-checks', onClick: () => go('quiz') });
    this.btn(row, 'Défi chrono', { icon: 'timer', onClick: () => go('challenge'), title: 'QCM rapides et chronométrés, pour réviser ce que tu connais déjà' });
    row.createDiv({ cls: 'mentor-spacer' });
    this.btn(row, 'Note ouverte', { icon: 'file-text', kind: 'ghost', onClick: () => this.plugin.pickActive(), title: 'Apprendre la note ouverte et ses notes liées' });
    this.btn(row, 'Choisir…', { icon: 'folder-search', kind: 'ghost', onClick: () => this.plugin.pickAny(), title: 'Une note ou un dossier de cours' });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go('lesson'); } });

    const queue = reviewQueue(this.data, this.plugin.settings.newPerDay);
    const todayBox = el.createDiv({ cls: 'mentor-panel mentor-today' });
    ring(todayBox, queue.length ? null : 1, 56, String(queue.length));
    const tt = todayBox.createDiv({ cls: 'mentor-today-txt' });
    const st = streak(this.data);
    if (queue.length) {
      tt.createDiv({ cls: 'mentor-today-h', text: `${plural(queue.length, 'fiche', 'fiches')} à revoir aujourd’hui` });
      tt.createDiv({ cls: 'mentor-dim', text: `Environ ${Math.max(1, Math.round(queue.length * 0.4))} min · sujets mélangés${st ? ` · ${plural(st, 'jour', 'jours')} d’affilée` : ''}` });
      this.btn(todayBox, 'Réviser', { icon: 'play', kind: 'primary', onClick: () => this.review() });
    } else {
      const next = nextReview(this.data);
      tt.createDiv({ cls: 'mentor-today-h', text: Object.keys(this.data.cards).length ? 'Tout est à jour' : 'Pas encore de fiches' });
      tt.createDiv({ cls: 'mentor-dim', text: next ? `Prochaine révision ${fmtDay(next.at)} (${plural(next.count, 'fiche', 'fiches')}).${st ? ` ${plural(st, 'jour', 'jours')} d’affilée.` : ''}` : 'Elles se créent à la fin de chaque leçon et après tes quiz.' });
    }

    const topics = Object.values(this.data.topics).sort((a, b) => (b.lastStudied ?? b.created).localeCompare(a.lastStudied ?? a.created));
    if (!topics.length) { this.howItWorks(el); return; }
    el.createEl('h2', { cls: 'mentor-h2', text: 'Tes sujets' });
    const list = el.createDiv({ cls: 'mentor-topics' });
    for (const t of topics) this.topicRow(list, t);
    this.howItWorks(el, true);
  }

  private topicRow(list: HTMLElement, t: Topic) {
    const m = mastery(this.data, t);
    const item = list.createDiv({ cls: 'mentor-topic' });
    ring(item, m.value, 48);
    const info = item.createDiv({ cls: 'mentor-topic-info' });
    info.createDiv({ cls: 'mentor-topic-title', text: t.title });
    const meta: string[] = [];
    if (t.lessons) meta.push(plural(t.lessons, 'leçon', 'leçons'));
    if (m.lastQuiz) meta.push(`quiz ${m.lastQuiz.score}/${m.lastQuiz.total}`);
    if (t.bestChallenge) meta.push(`record défi ${t.bestChallenge}`);
    if (m.cards) meta.push(plural(m.cards, 'fiche', 'fiches'));
    info.createDiv({ cls: 'mentor-dim', text: meta.join(' · ') || 'Pas encore commencé' });
    const weak = Object.entries(t.concepts).filter(([, v]) => v < 0.6).map(([k]) => k);
    if (weak.length) {
      const chips = info.createDiv({ cls: 'mentor-chips' });
      for (const w of weak.slice(0, 4)) chips.createSpan({ cls: 'mentor-chip is-weak', text: w });
    }
    // One recommended next step; the rest stays one click away.
    const acts = item.createDiv({ cls: 'mentor-topic-acts' });
    const next = !t.lessons ? 'lesson' : m.due ? 'review' : !m.lastQuiz ? 'quiz' : weak.length ? 'focus' : 'challenge';
    const labels = { lesson: ['Commencer la leçon', 'presentation'], review: [`Réviser (${m.due})`, 'rotate-ccw'], quiz: ['Faire un quiz', 'list-checks'], focus: ['Retravailler les points fragiles', 'target'], challenge: ['Défi chrono', 'timer'] } as const;
    const run = {
      lesson: () => void this.startTopic(t, 'lesson'), review: () => this.review(t.id), quiz: () => void this.startTopic(t, 'quiz', weak),
      focus: () => void this.startTopic(t, 'lesson', weak, true), challenge: () => void this.startTopic(t, 'challenge'),
    };
    this.btn(acts, labels[next][0], { icon: labels[next][1], kind: 'primary', onClick: run[next] });
    const more = acts.createEl('button', { cls: 'mentor-icon-btn', attr: { 'aria-label': 'Autres actions' } });
    setIcon(more, 'more-horizontal');
    more.onclick = (e) => this.topicMenu(e, t, weak, m.cards > 0);
  }

  private topicMenu(e: MouseEvent, t: Topic, weak: string[], hasCards: boolean) {
    const menu = new Menu();
    menu.addItem(i => i.setTitle('Leçon guidée').setIcon('presentation').onClick(() => void this.startTopic(t, 'lesson')));
    if (t.guide) menu.addItem(i => i.setTitle('Leçon avec un nouveau plan').setIcon('refresh-cw').onClick(() => void this.startTopic(t, 'lesson', weak, true)));
    menu.addItem(i => i.setTitle('Quiz').setIcon('list-checks').onClick(() => void this.startTopic(t, 'quiz', weak)));
    menu.addItem(i => i.setTitle('Défi chrono').setIcon('timer').onClick(() => void this.startTopic(t, 'challenge', weak)));
    if (hasCards) menu.addItem(i => i.setTitle('Réviser ses fiches').setIcon('rotate-ccw').onClick(() => this.review(t.id)));
    if (t.kind !== 'query') menu.addItem(i => i.setTitle('Ouvrir la source').setIcon('file-text').onClick(() => void this.app.workspace.openLinkText(t.ref, '', 'tab')));
    menu.addSeparator();
    menu.addItem(i => i.setTitle('Retirer ce sujet et ses fiches').setIcon('trash-2').setWarning(true).onClick(async () => {
      delete this.data.topics[t.id];
      for (const [id, c] of Object.entries(this.data.cards)) if (c.topicId === t.id) delete this.data.cards[id];
      await this.plugin.saveAll();
      this.plugin.updateStatus();
      this.home();
    }));
    menu.showAtMouseEvent(e);
  }

  private howItWorks(el: HTMLElement, collapsed = false) {
    const d = el.createEl('details', { cls: 'mentor-how' });
    if (!collapsed) d.setAttr('open', '');
    d.createEl('summary', { text: collapsed ? 'Comment Mentor t’aide à apprendre' : 'Comment ça marche' });
    this.md(d.createDiv(), [
      '1. **Leçon guidée.** Mentor prépare un plan à partir de tes notes, te pose une question avant chaque notion (essayer avant d’apprendre aide à retenir), explique avec un exemple concret, puis te fait expliquer ou appliquer. Il passe à la suite quand tu as réussi seul. Un indice, un exemple ou une autre explication sont toujours à un clic.',
      '2. **Quiz.** Surtout des questions où tu rédiges ta réponse, avec ton niveau de confiance. Les erreurs commises en étant sûr de toi sont signalées : ce sont celles qu’on retient le mieux une fois corrigées.',
      '3. **Défi chrono.** Des QCM rapides et chronométrés pour réviser en jouant ce que tu connais déjà.',
      '4. **Révision espacée.** Les fiches reviennent juste avant que tu les oublies (algorithme FSRS, celui d’Anki), sujets mélangés. Quelques minutes par jour suffisent.',
      '',
      'Se tester, espacer ses révisions et s’expliquer les choses : la recherche en sciences cognitives classe ces pratiques parmi les plus efficaces.',
    ].join('\n'));
  }

  // ================================================================== topics & sources

  async startTopic(ref: { kind: Topic['kind']; ref: string; title: string }, mode: Mode, focus: string[] = [], freshPlan = false) {
    const topic = this.plugin.ensureTopic(ref.kind, ref.ref, ref.title);
    const el = this.reset('loading');
    this.header(el, topic.title, mode === 'lesson' ? 'Leçon guidée' : mode === 'quiz' ? 'Quiz' : 'Défi chrono');
    const w = this.waiting(el, 'Je rassemble tes notes…');
    let sources: SourceSet;
    try { sources = await this.collect(topic); } catch (e) { w.fail((e as Error).message); return; }
    if (!sources.files.length) {
      w.fail('Aucune note de ton vault ne correspond. Essaie avec les mots exacts de ton cours, ou choisis directement une note ou un dossier.');
      return;
    }
    w.done();
    if (mode === 'lesson') void this.prepareLesson(topic, sources, focus, freshPlan || focus.length > 0);
    else if (mode === 'quiz') void this.quiz(topic, sources, focus);
    else void this.challenge(topic, sources, focus);
  }

  private async collect(t: Topic): Promise<SourceSet> {
    const o = { budget: this.plugin.settings.budget, exclude: this.plugin.settings.exclude };
    if (t.kind === 'note') {
      const f = this.app.vault.getAbstractFileByPath(t.ref);
      if (!(f instanceof TFile)) throw new Error(`La note « ${t.ref} » n’existe plus.`);
      return fromNote(this.app, f, o);
    }
    if (t.kind === 'folder') {
      const f = this.app.vault.getAbstractFileByPath(t.ref);
      if (!(f instanceof TFolder)) throw new Error(`Le dossier « ${t.ref} » n’existe plus.`);
      return fromFolder(this.app, f, o);
    }
    return fromQuery(this.app, t.ref, o);
  }

  private ctx(s: SourceSet) {
    return { sources: formatSources(s), allowGeneral: this.plugin.settings.allowGeneral, learner: this.plugin.settings.learner };
  }

  private sourcesLine(parent: HTMLElement, s: SourceSet) {
    const line = parent.createDiv({ cls: 'mentor-sources' });
    line.createSpan({ cls: 'mentor-dim', text: `D’après ${plural(s.files.length, 'note', 'notes')} : ` });
    s.files.slice(0, 6).forEach((f, i) => { if (i) line.createSpan({ cls: 'mentor-dim', text: ', ' }); this.link(line, f.path); });
    if (s.files.length > 6) line.createSpan({ cls: 'mentor-dim', text: ` et ${s.files.length - 6} autres` });
  }

  // ================================================================== guided lesson

  private async prepareLesson(topic: Topic, sources: SourceSet, focus: string[], fresh: boolean) {
    const el = this.reset('prep');
    this.header(el, topic.title, 'Leçon guidée');
    let guide = !fresh ? topic.guide : undefined;
    if (!guide) {
      const w = this.waiting(el, 'Je prépare ta leçon', `À partir de ${plural(sources.files.length, 'note', 'notes')}. Compte une minute environ.`);
      this.abort = new AbortController();
      try {
        guide = await this.plugin.claude.json<Guide>({ system: guideSystem(this.ctx(sources)), prompt: guidePrompt(focus), schema: GUIDE_SCHEMA, signal: this.abort.signal });
      } catch (e) { w.fail((e as Error).message, () => void this.prepareLesson(topic, sources, focus, fresh)); return; }
      if (!guide.concepts?.length) { w.fail('Le plan reçu est vide.', () => void this.prepareLesson(topic, sources, focus, true)); return; }
      w.done();
      topic.guide = guide;
      topic.guideAt = new Date().toISOString();
      await this.plugin.saveAll();
    }
    this.planScreen(el, topic, sources, guide, focus);
  }

  /** The plan before starting: the learner sees where the lesson goes and decides to begin. */
  private planScreen(el: HTMLElement, topic: Topic, sources: SourceSet, guide: Guide, focus: string[]) {
    const card = el.createDiv({ cls: 'mentor-panel mentor-plan mentor-enter' });
    const top = card.createDiv({ cls: 'mentor-plan-top' });
    core(top, 'idle', 48);
    const tt = top.createDiv();
    tt.createEl('h2', { cls: 'mentor-plan-title', text: guide.title });
    tt.createDiv({ cls: 'mentor-dim', text: `${plural(guide.concepts.length, 'notion', 'notions')} · environ ${guide.minutes || guide.concepts.length * 4} min` });
    const ol = card.createEl('ol', { cls: 'mentor-plan-list' });
    guide.concepts.forEach((c, i) => {
      const li = ol.createEl('li');
      li.setCssStyles({ animationDelay: `${i * 60}ms` });
      const known = topic.concepts[c.name];
      const line = li.createDiv({ cls: 'mentor-plan-line' });
      line.createSpan({ cls: 'mentor-plan-name', text: c.name });
      if (known !== undefined) line.createSpan({ cls: `mentor-chip ${known >= 0.75 ? 'is-ok' : 'is-weak'}`, text: known >= 0.75 ? 'acquis' : 'à revoir' });
      li.createDiv({ cls: 'mentor-dim', text: c.goal });
    });
    this.sourcesLine(card, sources);
    const row = card.createDiv({ cls: 'mentor-row' });
    this.btn(row, 'Commencer', { icon: 'play', kind: 'primary', onClick: () => this.lesson(topic, sources, guide) }).focus();
    if (topic.guideAt) this.btn(row, 'Nouveau plan', { icon: 'refresh-cw', kind: 'ghost', onClick: () => void this.prepareLesson(topic, sources, focus, true), title: 'Refaire le plan à partir de tes notes actuelles' });
  }

  private lesson(topic: Topic, sources: SourceSet, guide: Guide) {
    const el = this.reset('lesson');
    const bar = this.header(el, guide.title, 'Leçon guidée');
    const railBox = bar.createDiv({ cls: 'mentor-railbox' });
    const rail = railBox.createDiv({ cls: 'mentor-rail', attr: { role: 'list', 'aria-label': 'Plan de la leçon' } });
    const segs = guide.concepts.map((c, i) => rail.createDiv({ cls: 'mentor-rail-seg', attr: { role: 'listitem', title: `${i + 1}. ${c.name}` } }));
    const railLabel = railBox.createDiv({ cls: 'mentor-rail-label' });
    const mastered = new Set<string>();
    const setStep = (step: number) => {
      segs.forEach((s, i) => {
        s.toggleClass('is-current', i === step - 1);
        s.toggleClass('is-done', mastered.has(guide.concepts[i].name));
      });
      const c = guide.concepts[step - 1];
      railLabel.setText(c ? `${step}/${guide.concepts.length} · ${c.name}` : '');
    };
    setStep(1);

    const log = el.createDiv({ cls: 'mentor-log', attr: { 'aria-live': 'polite' } });
    const composer = el.createDiv({ cls: 'mentor-composer' });
    const helps = composer.createDiv({ cls: 'mentor-helps' });
    const box = composer.createDiv({ cls: 'mentor-compose-box' });
    const input = box.createEl('textarea', { cls: 'mentor-input', attr: { rows: '2', 'aria-label': 'Ta réponse', placeholder: 'Ta réponse, avec tes mots… (Entrée pour envoyer)' } });
    const send = box.createEl('button', { cls: 'mentor-send', attr: { 'aria-label': 'Envoyer' } });
    setIcon(send, 'arrow-up');
    const foot = composer.createDiv({ cls: 'mentor-row mentor-compose-foot' });
    foot.createSpan({ cls: 'mentor-dim', text: 'Maj+Entrée : nouvelle ligne' });
    foot.createDiv({ cls: 'mentor-spacer' });
    const transcript: Turn[] = [];
    const finish = this.btn(foot, 'Terminer la leçon', { icon: 'flag', kind: 'ghost', onClick: () => void this.wrapUp(topic, sources, transcript) });

    const HELP: [string, string, string][] = [
      ['Un indice', 'lightbulb', 'Donne-moi un indice, sans la réponse.'],
      ['Un exemple', 'box', 'Montre-moi un exemple concret.'],
      ['Explique autrement', 'refresh-cw', 'Je ne comprends pas encore. Explique autrement, plus simplement.'],
      ['Je ne sais pas', 'help-circle', 'Je ne sais pas.'],
      ['Je connais déjà', 'fast-forward', 'Je connais déjà cette notion : teste-moi directement avec une question plus difficile.'],
    ];
    const helpBtns = HELP.map(([label, icon, msg]) => this.btn(helps, label, { icon, kind: 'ghost', onClick: () => void submit(msg, label) }));

    const system = tutorSystem(this.ctx(sources), guide);
    let busy = false;
    const setBusy = (b: boolean) => {
      busy = b;
      send.disabled = b; input.disabled = b;
      helpBtns.forEach(x => (x.disabled = b));
      finish.disabled = b || transcript.length < 4;
    };
    const scroll = () => { log.scrollTo({ top: log.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' }); };

    const tutor = async () => {
      setBusy(true);
      const m = log.createDiv({ cls: 'mentor-msg is-tutor' });
      const c = core(m.createDiv({ cls: 'mentor-msg-av' }), 'thinking', 28);
      const body = m.createDiv({ cls: 'mentor-msg-body is-pending', text: 'Mentor réfléchit…' });
      scroll();
      this.abort = new AbortController();
      let last = 0;
      try {
        const r = await this.plugin.claude.run({
          system, prompt: tutorTurn(transcript), signal: this.abort.signal,
          onText: (full) => {
            const now = Date.now();
            if (now - last < 100) return;
            last = now;
            body.removeClass('is-pending');
            body.setText(parseTutor(full).body);
          },
        });
        const p = parseTutor(r.text);
        body.removeClass('is-pending');
        this.md(body, p.body, sources.files[0]?.path ?? '');
        transcript.push({ role: 'tutor', text: p.body });
        const before = mastered.size;
        for (const n of p.mastered ?? []) mastered.add(n);
        if (p.step) setStep(p.step);
        if (mastered.size > before) { c.set('ok'); burst(m.querySelector('.mentor-msg-av') as HTMLElement); } else c.set('idle');
        if (p.done) { segs.forEach(s => s.addClass('is-done')); railLabel.setText('Clôture'); finish.removeClass('is-ghost'); finish.addClass('is-primary'); }
      } catch (e) {
        c.set('wrong');
        body.removeClass('is-pending');
        body.empty();
        body.createDiv({ cls: 'mentor-error', text: (e as Error).message });
        this.btn(body, 'Réessayer', { icon: 'rotate-ccw', onClick: () => { m.remove(); void tutor(); } });
      } finally {
        setBusy(false);
        input.focus();
        scroll();
      }
    };

    const submit = async (text?: string, chip?: string) => {
      if (busy) return;
      const msg = (text ?? input.value).trim();
      if (!msg) return;
      if (!text) input.value = '';
      const m = log.createDiv({ cls: `mentor-msg is-learner${chip ? ' is-chip' : ''}` });
      const body = m.createDiv({ cls: 'mentor-msg-body' });
      if (chip) body.setText(chip); else this.md(body, msg);
      transcript.push({ role: 'learner', text: msg });
      await tutor();
    };

    send.onclick = () => void submit();
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); } });
    topic.lastStudied = new Date().toISOString();
    topic.lessons++;
    void this.plugin.saveAll();
    void tutor();
  }

  private async wrapUp(topic: Topic, sources: SourceSet, transcript: Turn[]) {
    const el = this.reset('wrap');
    this.header(el, topic.title, 'Fin de la leçon');
    const w = this.waiting(el, 'Je prépare ta synthèse et tes fiches', 'Une petite minute.');
    this.abort = new AbortController();
    let res: LessonWrapUp;
    try {
      res = await this.plugin.claude.json<LessonWrapUp>({ system: wrapSystem(this.ctx(sources)), prompt: wrapPrompt(transcript), schema: WRAP_SCHEMA, signal: this.abort.signal });
    } catch (e) { w.fail((e as Error).message, () => void this.wrapUp(topic, sources, transcript)); return; }
    w.done();
    for (const a of res.assessment ?? []) if (a.concept) topic.concepts[a.concept] = Math.max(0, Math.min(1, a.score));
    const added = this.plugin.addCards(topic, res.cards);
    await this.plugin.saveAll();

    const top = el.createDiv({ cls: 'mentor-panel mentor-result mentor-enter' });
    const cbox = top.createDiv({ cls: 'mentor-result-core' });
    core(cbox, 'ok', 64);
    burst(cbox, true);
    const tt = top.createDiv();
    tt.createEl('h2', { cls: 'mentor-result-h', text: 'Leçon terminée' });
    tt.createDiv({ cls: 'mentor-dim', text: added ? `${plural(added, 'fiche ajoutée', 'fiches ajoutées')} à ta révision. Première révision demain : c’est l’espacement qui fixe ce que tu viens d’apprendre.` : 'Ces notions sont déjà dans tes fiches.' });

    if (res.assessment?.length) this.conceptBars(el, res.assessment.map(a => [a.concept, a.score]));

    const weak = (res.assessment ?? []).filter(a => a.score < 0.75).map(a => a.concept);
    const row = el.createDiv({ cls: 'mentor-row' });
    this.btn(row, 'Faire un quiz maintenant', { icon: 'list-checks', kind: 'primary', onClick: () => void this.quiz(topic, sources, weak) });
    this.btn(row, 'Enregistrer la synthèse', { icon: 'save', onClick: async () => {
      const file = await this.plugin.saveSummary(topic, res.summary);
      if (file) { new Notice(`Synthèse enregistrée : ${file.path}`); void this.app.workspace.getLeaf('tab').openFile(file); }
    } });
    this.btn(row, 'Accueil', { icon: 'home', kind: 'ghost', onClick: () => this.home() });

    const sum = el.createEl('details', { cls: 'mentor-panel mentor-fold' });
    sum.createEl('summary', { text: 'Synthèse de la leçon' });
    this.md(sum.createDiv({ cls: 'mentor-prose' }), res.summary, sources.files[0]?.path ?? '');
    const cards = el.createEl('details', { cls: 'mentor-panel mentor-fold' });
    cards.createEl('summary', { text: `Les fiches (${res.cards.length})` });
    for (const c of res.cards) {
      const card = cards.createDiv({ cls: 'mentor-card-mini' });
      card.createDiv({ cls: 'mentor-card-q', text: c.front });
      card.createDiv({ cls: 'mentor-dim', text: c.back });
    }
  }

  private conceptBars(el: HTMLElement, items: [string, number][]) {
    const box = el.createDiv({ cls: 'mentor-concepts' });
    items.sort((a, b) => a[1] - b[1]).forEach(([c, v], i) => {
      const r = box.createDiv({ cls: 'mentor-concept' });
      r.createSpan({ text: c });
      const bar = r.createDiv({ cls: 'mentor-bar-track' });
      const f = bar.createDiv({ cls: `mentor-bar-fill${v < 0.5 ? ' is-low' : ''}` });
      f.setCssStyles({ '--to': String(Math.max(0.02, v)), animationDelay: `${120 + i * 70}ms` } as Partial<CSSStyleDeclaration>);
      r.createSpan({ cls: 'mentor-dim mentor-num', text: pct(v) });
    });
  }

  // ================================================================== quiz (untimed, animated)

  /** Points: 100 per right answer, 50 for a partial one; a streak multiplies them. */
  private scoreBox(bar: HTMLElement) {
    const box = bar.createDiv({ cls: 'mentor-score' });
    const pts = box.createDiv({ cls: 'mentor-score-pts', text: '0' });
    box.createDiv({ cls: 'mentor-score-l', text: 'points' });
    const series = box.createDiv({ cls: 'mentor-series' });
    let total = 0;
    let run = 0;
    return {
      get total() { return total; },
      add(base: number, right: boolean) {
        run = right ? run + 1 : 0;
        const mult = run >= 5 ? 2 : run >= 3 ? 1.5 : 1;
        const gain = Math.round(base * mult);
        const from = total;
        total += gain;
        countTo(pts, from, total);
        if (gain) {
          const pop = box.createDiv({ cls: 'mentor-gain', text: `+${gain}` });
          window.setTimeout(() => pop.remove(), 1100);
        }
        series.empty();
        if (run >= 3) { series.setText(`Série ×${run}`); series.removeClass('is-on'); void series.offsetWidth; series.addClass('is-on'); }
        else series.removeClass('is-on');
        return { gain, run, mult };
      },
    };
  }

  private async quiz(topic: Topic, sources: SourceSet, focus: string[]) {
    const el = this.reset('quiz');
    const bar = this.header(el, topic.title, 'Quiz');
    const stage = el.createDiv({ cls: 'mentor-stage' });
    const w = this.waiting(stage, 'Je prépare tes questions', `${plural(this.plugin.settings.quizSize, 'question', 'questions')} à partir de ${plural(sources.files.length, 'note', 'notes')}. Compte une minute environ.`);
    this.abort = new AbortController();
    let questions: QuizQuestion[];
    try {
      const r = await this.plugin.claude.json<{ questions: QuizQuestion[] }>({
        system: quizSystem(this.ctx(sources)), prompt: quizPrompt(this.plugin.settings.quizSize, focus), schema: QUIZ_SCHEMA, signal: this.abort.signal,
      });
      questions = (r.questions ?? []).filter(q => q.question && q.answer);
    } catch (e) { w.fail((e as Error).message, () => void this.quiz(topic, sources, focus)); return; }
    if (!questions.length) { w.fail('Aucune question reçue.', () => void this.quiz(topic, sources, focus)); return; }
    w.done();

    const dots = bar.createDiv({ cls: 'mentor-dots' });
    const dotEls = questions.map(() => dots.createDiv({ cls: 'mentor-dot' }));
    const score = this.scoreBox(bar);
    const results: QuizResult[] = [];
    let i = 0;
    const ctx = this.ctx(sources);

    const show = () => {
      stage.empty();
      if (i >= questions.length) { void this.quizEnd(topic, sources, results, score.total); return; }
      dotEls.forEach((d, k) => d.toggleClass('is-current', k === i));
      const q = questions[i];
      const card = stage.createDiv({ cls: 'mentor-panel mentor-q mentor-enter' });
      card.createDiv({ cls: 'mentor-q-meta', text: `Question ${i + 1} sur ${questions.length} · ${q.type === 'mcq' ? 'choix multiple' : q.type === 'apply' ? 'application' : 'explication'} · ${q.concept}` });
      this.md(card.createDiv({ cls: 'mentor-q-text' }), q.question, q.source);

      let choice = -1;
      let input: HTMLTextAreaElement | null = null;
      const opts = q.type === 'mcq' && q.options?.length ? card.createDiv({ cls: 'mentor-options', attr: { role: 'radiogroup' } }) : null;
      if (opts) {
        q.options!.forEach((o, k) => {
          const b = opts.createEl('button', { cls: 'mentor-option', attr: { role: 'radio', 'aria-checked': 'false' } });
          b.setCssStyles({ animationDelay: `${80 + k * 60}ms` });
          b.createSpan({ cls: 'mentor-option-k', text: String.fromCharCode(65 + k) });
          b.createSpan({ cls: 'mentor-option-t', text: o });
          b.onclick = () => {
            choice = k;
            opts.querySelectorAll('.mentor-option').forEach(x => { x.removeClass('is-picked'); x.setAttr('aria-checked', 'false'); });
            b.addClass('is-picked'); b.setAttr('aria-checked', 'true');
          };
        });
      } else {
        input = card.createEl('textarea', { cls: 'mentor-input', attr: { rows: '4', 'aria-label': 'Ta réponse', placeholder: 'Rédige ta réponse avec tes mots, même incomplète.' } });
        window.setTimeout(() => input?.focus(), 60);
      }

      const conf = card.createDiv({ cls: 'mentor-conf' });
      conf.createSpan({ cls: 'mentor-dim', text: 'Tu es sûr de toi ?' });
      const seg = conf.createDiv({ cls: 'mentor-seg', attr: { role: 'radiogroup', 'aria-label': 'Confiance' } });
      let sure = -1;
      ['Je devine', 'Plutôt', 'Certain'].forEach((l, k) => {
        const b = seg.createEl('button', { cls: 'mentor-seg-btn', text: l, attr: { role: 'radio', 'aria-checked': 'false' } });
        b.onclick = () => { sure = k; seg.querySelectorAll('button').forEach(x => { x.removeClass('is-picked'); x.setAttr('aria-checked', 'false'); }); b.addClass('is-picked'); b.setAttr('aria-checked', 'true'); hint.setText(''); };
      });
      const hint = card.createDiv({ cls: 'mentor-hint' });

      const row = card.createDiv({ cls: 'mentor-row' });
      const validate = this.btn(row, 'Valider', { icon: 'check', kind: 'primary', onClick: () => void check() });
      const skip = this.btn(row, 'Je ne sais pas', { kind: 'ghost', onClick: () => { if (input) input.value = ''; choice = -2; sure = 0; void check(); } });
      const fb = stage.createDiv({ cls: 'mentor-feedback' });

      // Keyboard: A-D or 1-4 to choose, Ctrl+Entrée to validate.
      this.onKeys((e) => {
        if (document.activeElement === input) return;
        const k = 'abcd'.indexOf(e.key.toLowerCase());
        const n = Number(e.key) - 1;
        const idx = k >= 0 ? k : n >= 0 && n < 4 ? n : -1;
        if (opts && idx >= 0 && idx < (q.options?.length ?? 0)) { (opts.children[idx] as HTMLButtonElement).click(); e.preventDefault(); }
      });

      const check = async () => {
        const answer = input ? input.value.trim() : choice >= 0 ? q.options![choice] : '';
        if (choice !== -2 && !answer) { hint.setText('Écris ou choisis une réponse, même incertaine : se tromper fait partie de l’apprentissage.'); input?.focus(); return; }
        if (sure < 0) { hint.setText('Indique d’abord ta confiance : ça permet de repérer les fausses certitudes.'); seg.addClass('is-shake'); window.setTimeout(() => seg.removeClass('is-shake'), 450); return; }
        validate.disabled = true; skip.disabled = true;
        if (input) input.disabled = true;
        card.querySelectorAll('.mentor-option, .mentor-seg-btn').forEach(b => ((b as HTMLButtonElement).disabled = true));
        fb.empty();
        fb.removeClass('is-ok', 'is-partial', 'is-wrong');
        const coreBox = fb.createDiv({ cls: 'mentor-fb-core' });
        const c = core(coreBox, 'thinking', 44);
        const fbBody = fb.createDiv({ cls: 'mentor-fb-body' });
        fb.addClass('is-open');
        let grade: Grade;
        if (q.type === 'mcq' && q.options?.length && typeof q.correct === 'number') {
          const ok = choice === q.correct;
          grade = { score: ok ? 1 : 0, verdict: ok ? 'Juste' : 'Pas encore', feedback: ok ? q.answer : `La bonne réponse était **${String.fromCharCode(65 + q.correct)}**. ${q.answer}`, missing: ok ? [] : q.keyPoints };
          opts?.querySelectorAll('.mentor-option').forEach((b, k) => { if (k === q.correct) b.addClass('is-right'); else if (k === choice) b.addClass('is-wrongpick'); else b.addClass('is-faded'); });
        } else if (!answer) {
          grade = { score: 0, verdict: 'À apprendre', feedback: q.answer, missing: q.keyPoints };
        } else {
          fbBody.createDiv({ cls: 'mentor-dim', text: 'Mentor corrige ta réponse…' });
          try {
            grade = await this.plugin.claude.json<Grade>({ system: GRADE_SYSTEM, prompt: gradePrompt(q, answer, sure), schema: GRADE_SCHEMA });
          } catch (e) {
            c.set('wrong');
            fbBody.empty();
            fbBody.createDiv({ cls: 'mentor-error', text: (e as Error).message });
            this.btn(fbBody, 'Réessayer la correction', { icon: 'rotate-ccw', onClick: () => { void check(); } });
            validate.disabled = false; skip.disabled = false;
            return;
          }
        }
        results.push({ q, score: grade.score, sure, answer });
        const state: CoreState = grade.score >= 1 ? 'ok' : grade.score > 0 ? 'partial' : 'wrong';
        c.set(state);
        dotEls[i].addClass(`is-${state}`);
        fb.addClass(`is-${state}`);
        card.addClass(`is-${state}`);
        const s = score.add(grade.score >= 1 ? 100 : grade.score > 0 ? 50 : 0, grade.score >= 1);
        if (state === 'ok') burst(coreBox, s.run >= 3);
        fbBody.empty();
        const head = fbBody.createDiv({ cls: 'mentor-fb-head' });
        head.createSpan({ cls: 'mentor-fb-verdict', text: grade.verdict });
        if (s.gain) head.createSpan({ cls: 'mentor-fb-pts', text: `+${s.gain}${s.mult > 1 ? ` (série ×${s.run})` : ''}` });
        if (sure === 2 && grade.score < 1) head.createSpan({ cls: 'mentor-chip is-weak', text: 'Tu étais sûr de toi : retiens bien celle-ci' });
        this.md(fbBody.createDiv({ cls: 'mentor-prose' }), grade.feedback, q.source);
        if (q.type !== 'mcq' && grade.score < 1) {
          const model = fbBody.createEl('details', { cls: 'mentor-model' });
          model.createEl('summary', { text: 'Voir la réponse modèle' });
          this.md(model.createDiv({ cls: 'mentor-prose' }), q.answer, q.source);
        }
        const src = fbBody.createDiv({ cls: 'mentor-dim' });
        src.createSpan({ text: 'Dans ta note ' });
        this.link(src, q.source);
        const actions = fbBody.createDiv({ cls: 'mentor-row' });
        const next = this.btn(actions, i + 1 < questions.length ? 'Question suivante' : 'Voir le bilan', { icon: 'arrow-right', kind: 'primary', onClick: () => { i++; show(); } });
        if (grade.score < 1) {
          const ex = this.btn(actions, 'Explique-moi', { icon: 'message-circle', onClick: async () => {
            ex.disabled = true;
            const out = fbBody.createDiv({ cls: 'mentor-explain mentor-prose', text: 'Mentor prépare une explication…' });
            try {
              const r = await this.plugin.claude.run({ system: explainSystem(ctx), prompt: explainPrompt(q, answer), onText: (t) => out.setText(t) });
              this.md(out, r.text, q.source);
            } catch (e2) { out.setText((e2 as Error).message); ex.disabled = false; }
          } });
        }
        next.focus();
        fb.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
      };
      input?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void check(); } });
    };
    show();
  }

  private async quizEnd(topic: Topic, sources: SourceSet, results: QuizResult[], points: number) {
    const el = this.reset('quiz-end');
    this.header(el, topic.title, 'Bilan du quiz');
    const total = results.length;
    const score = results.reduce((a, r) => a + r.score, 0);
    const over = results.filter(r => r.sure === 2 && r.score < 1);
    const under = results.filter(r => r.sure === 0 && r.score >= 1).length;
    const byConcept = new Map<string, number[]>();
    for (const r of results) { const l = byConcept.get(r.q.concept) ?? []; l.push(r.score); byConcept.set(r.q.concept, l); }
    for (const [c, l] of byConcept) topic.concepts[c] = avg(l);
    this.data.quizzes.push({ topicId: topic.id, date: new Date().toISOString(), score, total, overconfident: over.length });
    topic.lastStudied = new Date().toISOString();

    const ratio = score / Math.max(total, 1);
    const top = el.createDiv({ cls: 'mentor-panel mentor-result mentor-enter' });
    const rbox = top.createDiv({ cls: 'mentor-result-core' });
    const r = ring(rbox, ratio, 96, `${score % 1 ? score.toFixed(1) : score}/${total}`);
    r.addClass('is-animated');
    if (ratio >= 0.6) window.setTimeout(() => burst(rbox, ratio >= 0.85), 500);
    const tt = top.createDiv();
    tt.createEl('h2', { cls: 'mentor-result-h', text: ratio >= 0.85 ? 'Très solide' : ratio >= 0.6 ? 'Bonne base, quelques trous' : 'Ça se travaille, et on sait par où commencer' });
    const pts = tt.createDiv({ cls: 'mentor-result-pts' });
    const ptsV = pts.createSpan({ text: '0' });
    pts.createSpan({ cls: 'mentor-dim', text: ' points' });
    countTo(ptsV, 0, points, 1100);
    const lines: string[] = [];
    if (over.length) lines.push(`${plural(over.length, 'réponse donnée', 'réponses données')} comme certaine${over.length > 1 ? 's' : ''} mais fausse${over.length > 1 ? 's' : ''}. Ce sont les erreurs qu’on corrige le mieux : elles passent en tête de tes fiches.`);
    if (under) lines.push(`${plural(under, 'bonne réponse donnée', 'bonnes réponses données')} en devinant : tu en sais plus que tu ne le crois.`);
    if (!lines.length) lines.push('Ta confiance correspond bien à ce que tu sais.');
    for (const l of lines) tt.createDiv({ cls: 'mentor-dim', text: l });

    this.conceptBars(el, [...byConcept].map(([c, l]) => [c, avg(l)]));

    const missed = results.filter(x => x.score < 1).sort((a, b) => b.sure - a.sure);
    const weak = [...byConcept].filter(([, l]) => avg(l) < 0.75).map(([c]) => c);
    if (missed.length) {
      this.plugin.addCards(topic, missed.map(x => ({
        front: x.q.question + (x.q.type === 'mcq' && x.q.options ? '\n\n' + x.q.options.map((o, k) => `${String.fromCharCode(65 + k)}. ${o}`).join('\n') : ''),
        back: x.q.answer, concept: x.q.concept, source: x.q.source,
      })));
      el.createDiv({ cls: 'mentor-dim', text: `${plural(missed.length, 'question manquée ajoutée', 'questions manquées ajoutées')} à tes fiches de révision.` });
    }
    await this.plugin.saveAll();
    const row = el.createDiv({ cls: 'mentor-row' });
    if (weak.length) this.btn(row, 'Leçon sur les points fragiles', { icon: 'target', kind: 'primary', onClick: () => void this.prepareLesson(topic, sources, weak, true) });
    else this.btn(row, 'Défi chrono', { icon: 'timer', kind: 'primary', onClick: () => void this.challenge(topic, sources, []) });
    this.btn(row, 'Nouveau quiz', { icon: 'refresh-cw', onClick: () => void this.quiz(topic, sources, weak) });
    this.btn(row, 'Accueil', { icon: 'home', kind: 'ghost', onClick: () => this.home() });
  }

  // ================================================================== timed challenge (Kahoot-style)

  private async challenge(topic: Topic, sources: SourceSet, focus: string[]) {
    const el = this.reset('challenge');
    const bar = this.header(el, topic.title, 'Défi chrono');
    const stage = el.createDiv({ cls: 'mentor-stage' });
    const n = Math.max(8, this.plugin.settings.quizSize);
    const w = this.waiting(stage, 'Je prépare ton défi', `${n} QCM rapides, ${CHALLENGE_SECONDS} secondes chacun.`);
    this.abort = new AbortController();
    let questions: QuizQuestion[];
    try {
      const r = await this.plugin.claude.json<{ questions: QuizQuestion[] }>({
        system: quizSystem(this.ctx(sources)), prompt: challengePrompt(n, focus), schema: QUIZ_SCHEMA, signal: this.abort.signal,
      });
      questions = (r.questions ?? []).filter(q => q.type === 'mcq' && q.options?.length && typeof q.correct === 'number');
    } catch (e) { w.fail((e as Error).message, () => void this.challenge(topic, sources, focus)); return; }
    if (!questions.length) { w.fail('Aucune question reçue.', () => void this.challenge(topic, sources, focus)); return; }
    w.done();

    const dots = bar.createDiv({ cls: 'mentor-dots' });
    const dotEls = questions.map(() => dots.createDiv({ cls: 'mentor-dot' }));
    const score = this.scoreBox(bar);
    const results: QuizResult[] = [];
    let i = 0;

    // Generation takes a while: the learner may have looked away, so the clock only starts on their signal.
    const ready = stage.createDiv({ cls: 'mentor-countdown mentor-enter' });
    core(ready, 'idle', 72);
    ready.createDiv({ cls: 'mentor-waiting-title', text: `${questions.length} questions prêtes` });
    ready.createDiv({ cls: 'mentor-dim', text: `${CHALLENGE_SECONDS} secondes par question. Plus tu réponds vite, plus tu marques. Touches A, B, C, D.` });
    const go = this.btn(ready, 'C’est parti', { icon: 'play', kind: 'primary', onClick: () => countdown() });
    window.setTimeout(() => go.focus(), 50);

    const countdown = () => {
      stage.empty();
      const intro = stage.createDiv({ cls: 'mentor-countdown' });
      const num = intro.createDiv({ cls: 'mentor-countdown-n is-pop', text: '3' });
      let c3 = 3;
      const tick = window.setInterval(() => {
        c3--;
        if (c3 <= 0) { window.clearInterval(tick); show(); return; }
        num.setText(String(c3));
        num.removeClass('is-pop'); void num.offsetWidth; num.addClass('is-pop');
      }, 800);
      this.timers.push(tick);
    };

    const show = () => {
      stage.empty();
      if (i >= questions.length) { void this.challengeEnd(topic, sources, results, score.total); return; }
      dotEls.forEach((d, k) => d.toggleClass('is-current', k === i));
      const q = questions[i];
      const card = stage.createDiv({ cls: 'mentor-panel mentor-q is-challenge mentor-enter' });
      const timeBar = card.createDiv({ cls: 'mentor-timer' });
      const timeFill = timeBar.createDiv({ cls: 'mentor-timer-fill' });
      const secs = card.createDiv({ cls: 'mentor-timer-s', text: String(CHALLENGE_SECONDS) });
      card.createDiv({ cls: 'mentor-q-meta', text: `Question ${i + 1} sur ${questions.length} · ${q.concept}` });
      this.md(card.createDiv({ cls: 'mentor-q-text' }), q.question, q.source);
      const opts = card.createDiv({ cls: 'mentor-options is-grid' });
      const startAt = performance.now();
      let answered = false;
      timeFill.setCssStyles({ transitionDuration: `${CHALLENGE_SECONDS}s` });
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => timeFill.addClass('is-running')));
      const secTimer = window.setInterval(() => {
        const left = Math.max(0, CHALLENGE_SECONDS - (performance.now() - startAt) / 1000);
        secs.setText(String(Math.ceil(left)));
        if (left <= 5) secs.addClass('is-low');
        if (left <= 0) answer(-1);
      }, 200);
      this.timers.push(secTimer);

      const answer = (k: number) => {
        if (answered) return;
        answered = true;
        window.clearInterval(secTimer);
        timeFill.removeClass('is-running');
        const elapsed = (performance.now() - startAt) / 1000;
        timeFill.setCssStyles({ transitionDuration: '0s', transform: `scaleX(${Math.max(0, 1 - elapsed / CHALLENGE_SECONDS)})` });
        const ok = k === q.correct;
        opts.querySelectorAll('.mentor-option').forEach((b, idx) => {
          (b as HTMLButtonElement).disabled = true;
          if (idx === q.correct) b.addClass('is-right'); else if (idx === k) b.addClass('is-wrongpick'); else b.addClass('is-faded');
        });
        // Kahoot-like: faster right answers earn more.
        const speed = Math.max(0, 1 - elapsed / CHALLENGE_SECONDS);
        const s = score.add(ok ? Math.round(500 + 500 * speed) : 0, ok);
        results.push({ q, score: ok ? 1 : 0, sure: 1, answer: k >= 0 ? q.options![k] : '' });
        const state: CoreState = ok ? 'ok' : 'wrong';
        dotEls[i].addClass(`is-${state}`);
        card.addClass(`is-${state}`);
        const fb = card.createDiv({ cls: `mentor-flash-fb is-${state}` });
        const cb = fb.createDiv({ cls: 'mentor-fb-core' });
        core(cb, state, 36);
        if (ok) burst(cb, s.run >= 3);
        const t = fb.createDiv();
        t.createDiv({ cls: 'mentor-fb-verdict', text: k < 0 ? 'Temps écoulé' : ok ? `Juste · +${s.gain}` : 'Raté' });
        t.createDiv({ cls: 'mentor-dim', text: q.answer });
        const nxt = this.btn(fb, i + 1 < questions.length ? 'Suivante' : 'Résultat', { icon: 'arrow-right', kind: 'primary', onClick: () => { i++; show(); } });
        nxt.focus();
        this.onKeys((e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nxt.click(); } });
      };

      q.options!.forEach((o, k) => {
        const b = opts.createEl('button', { cls: `mentor-option is-c${k}` });
        b.setCssStyles({ animationDelay: `${k * 50}ms` });
        b.createSpan({ cls: 'mentor-option-k', text: String.fromCharCode(65 + k) });
        b.createSpan({ cls: 'mentor-option-t', text: o });
        b.onclick = () => answer(k);
      });
      this.onKeys((e) => {
        const k = 'abcd'.indexOf(e.key.toLowerCase());
        const n2 = Number(e.key) - 1;
        const idx = k >= 0 ? k : n2 >= 0 && n2 < 4 ? n2 : -1;
        if (idx >= 0 && idx < q.options!.length) { e.preventDefault(); answer(idx); }
      });
      this.contentEl.focus();
    };
  }

  private async challengeEnd(topic: Topic, sources: SourceSet, results: QuizResult[], points: number) {
    const el = this.reset('challenge-end');
    this.header(el, topic.title, 'Résultat du défi');
    const right = results.filter(r => r.score >= 1).length;
    const best = topic.bestChallenge ?? 0;
    const record = points > best;
    if (record) topic.bestChallenge = points;
    const byConcept = new Map<string, number[]>();
    for (const r of results) { const l = byConcept.get(r.q.concept) ?? []; l.push(r.score); byConcept.set(r.q.concept, l); }
    for (const [c, l] of byConcept) topic.concepts[c] = Math.min(topic.concepts[c] ?? 1, avg(l));
    topic.lastStudied = new Date().toISOString();
    const missed = results.filter(r => r.score < 1);
    if (missed.length) {
      this.plugin.addCards(topic, missed.map(x => ({ front: x.q.question, back: `${x.q.options![x.q.correct!]}. ${x.q.answer}`, concept: x.q.concept, source: x.q.source })));
    }
    await this.plugin.saveAll();

    const top = el.createDiv({ cls: 'mentor-panel mentor-result mentor-enter' });
    const rbox = top.createDiv({ cls: 'mentor-result-core' });
    ring(rbox, right / Math.max(results.length, 1), 96, `${right}/${results.length}`).addClass('is-animated');
    window.setTimeout(() => burst(rbox, record), 500);
    const tt = top.createDiv();
    tt.createEl('h2', { cls: 'mentor-result-h', text: record ? (best ? 'Nouveau record' : 'Premier record') : 'Défi terminé' });
    const pts = tt.createDiv({ cls: 'mentor-result-pts' });
    const v = pts.createSpan({ text: '0' });
    pts.createSpan({ cls: 'mentor-dim', text: ' points' });
    countTo(v, 0, points, 1200);
    tt.createDiv({ cls: 'mentor-dim', text: record && best ? `Ancien record : ${best}.` : !record ? `Ton record : ${best}.` : 'Refais-le dans quelques jours pour voir si ça tient.' });
    if (missed.length) tt.createDiv({ cls: 'mentor-dim', text: `${plural(missed.length, 'question ratée ajoutée', 'questions ratées ajoutées')} à tes fiches.` });
    const row = el.createDiv({ cls: 'mentor-row' });
    this.btn(row, 'Rejouer', { icon: 'rotate-ccw', kind: 'primary', onClick: () => void this.challenge(topic, sources, []) });
    this.btn(row, 'Accueil', { icon: 'home', kind: 'ghost', onClick: () => this.home() });
  }

  // ================================================================== spaced review

  review(topicFilter?: string) {
    const el = this.reset('review');
    const bar = this.header(el, topicFilter ? this.data.topics[topicFilter]?.title ?? 'Révision' : 'Révision du jour', topicFilter ? 'Révision' : 'Sujets mélangés');
    const track = bar.createDiv({ cls: 'mentor-progress' });
    const fill = track.createDiv({ cls: 'mentor-progress-fill' });
    const stage = el.createDiv({ cls: 'mentor-stage' });
    const queue: StoredCard[] = reviewQueue(this.data, this.plugin.settings.newPerDay, topicFilter);
    const start = queue.length;
    let done = 0;
    let again = 0;

    const next = () => {
      stage.empty();
      fill.setCssStyles({ transform: `scaleX(${start ? Math.min(1, done / (start + again)) : 1})` });
      queue.sort((a, b) => (new Date(a.fsrs.due).getTime() <= Date.now() ? 0 : 1) - (new Date(b.fsrs.due).getTime() <= Date.now() ? 0 : 1));
      const card = queue[0];
      if (!card || new Date(card.fsrs.due).getTime() > Date.now() + 20 * 60000) {
        const end = stage.createDiv({ cls: 'mentor-panel mentor-result mentor-enter' });
        const cb = end.createDiv({ cls: 'mentor-result-core' });
        core(cb, done ? 'ok' : 'idle', 64);
        if (done) burst(cb, done >= 10);
        const tt = end.createDiv();
        tt.createEl('h2', { cls: 'mentor-result-h', text: done ? 'Révision terminée' : 'Rien à revoir pour l’instant' });
        const nx = nextReview(this.data);
        tt.createDiv({ cls: 'mentor-dim', text: done ? `${plural(done, 'fiche revue', 'fiches revues')}.${nx ? ` Prochaine révision ${fmtDay(nx.at)}.` : ''} L’espacement fait le reste.` : nx ? `Prochaine révision ${fmtDay(nx.at)}.` : '' });
        this.btn(stage, 'Accueil', { icon: 'home', kind: 'primary', onClick: () => this.home() });
        return;
      }
      const topic = this.data.topics[card.topicId];
      const box = stage.createDiv({ cls: 'mentor-panel mentor-flash mentor-enter' });
      box.createDiv({ cls: 'mentor-q-meta', text: [topic?.title, card.concept].filter(Boolean).join(' · ') });
      this.md(box.createDiv({ cls: 'mentor-q-text' }), card.front, card.source);
      const attempt = box.createEl('textarea', { cls: 'mentor-input', attr: { rows: '2', 'aria-label': 'Ta réponse', placeholder: 'Essaie de répondre de mémoire avant de regarder.' } });
      const row = box.createDiv({ cls: 'mentor-row' });
      this.btn(row, 'Voir la réponse', { icon: 'eye', kind: 'primary', onClick: () => show() });
      row.createSpan({ cls: 'mentor-dim', text: 'Entrée' });
      window.setTimeout(() => attempt.focus(), 60);
      attempt.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); show(); } });

      let shown = false;
      const show = () => {
        if (shown) return;
        shown = true;
        row.remove();
        attempt.disabled = true;
        if (!attempt.value.trim()) attempt.addClass('is-empty');
        const ans = box.createDiv({ cls: 'mentor-answer' });
        this.md(ans.createDiv({ cls: 'mentor-prose' }), card.back, card.source);
        if (card.source) { const s = ans.createDiv({ cls: 'mentor-dim' }); s.createSpan({ text: 'Dans ta note ' }); this.link(s, card.source); }
        box.createDiv({ cls: 'mentor-dim mentor-grade-q', text: 'Comment ça s’est passé ?' });
        const grades = box.createDiv({ cls: 'mentor-grades' });
        const prev = this.plugin.scheduler.preview(card.fsrs);
        const opts: [FsrsGrade, string, string][] = [
          [Rating.Again, 'Oublié', '1'], [Rating.Hard, 'Difficile', '2'], [Rating.Good, 'Trouvé', '3'], [Rating.Easy, 'Facile', '4'],
        ];
        for (const [g, label, key] of opts) {
          const b = grades.createEl('button', { cls: `mentor-grade g-${g}` });
          b.createDiv({ cls: 'mentor-grade-l', text: label });
          b.createDiv({ cls: 'mentor-dim', text: `revient dans ${fmtInterval(prev[g])}` });
          b.createDiv({ cls: 'mentor-key', text: key });
          b.onclick = () => void rate(g);
        }
        this.onKeys((e) => { const k = Number(e.key); if (k >= 1 && k <= 4) { e.preventDefault(); void rate(k as FsrsGrade); } });
        this.contentEl.focus();
        let rated = false;
        const rate = async (g: FsrsGrade) => {
          if (rated) return;
          rated = true;
          const wasNew = card.fsrs.state === 0;
          card.fsrs = this.plugin.scheduler.grade(card.fsrs, g);
          this.data.reviewDays[today()] = (this.data.reviewDays[today()] ?? 0) + 1;
          if (wasNew) this.data.reviewDays[`new:${today()}`] = (this.data.reviewDays[`new:${today()}`] ?? 0) + 1;
          const t = this.data.topics[card.topicId];
          if (t) { t.concepts[card.concept] = g === Rating.Again ? 0 : g === Rating.Hard ? 0.6 : 1; t.lastStudied = new Date().toISOString(); }
          done++;
          queue.shift();
          // Successive relearning: a forgotten card comes back in this session until it is recalled once.
          if (new Date(card.fsrs.due).getTime() < Date.now() + 20 * 60000) { queue.push(card); again++; }
          await this.plugin.saveAll();
          this.plugin.updateStatus();
          next();
        };
      };
    };
    next();
  }
}
