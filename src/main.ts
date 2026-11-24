import { App, FuzzySuggestModal, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, TFolder, normalizePath, type SettingDefinitionItem } from 'obsidian';
import { ClaudeRunner, detectClaude } from './claude';
import { EMPTY_DATA, Scheduler, normalizeCard, reviewQueue, topicId, uid, type MentorData, type Topic, type TopicKind } from './store';
import { MentorView, VIEW_TYPE } from './view';
import { setLanguage, tr, type LangChoice } from './i18n';

interface MentorSettings {
  cliPath: string;
  model: string;
  budget: number;
  allowGeneral: boolean;
  exclude: string[];
  quizSize: number;
  newPerDay: number;
  retention: number;
  learner: string;
  summaryFolder: string;
  language: LangChoice;
}

const DEFAULTS: MentorSettings = {
  cliPath: '',
  model: 'sonnet',
  budget: 120000,
  allowGeneral: true,
  exclude: ['Templates', 'Excalidraw'],
  quizSize: 8,
  newPerDay: 20,
  retention: 0.9,
  learner: '',
  summaryFolder: 'Mentor',
  language: 'auto',
};

interface Saved { settings?: Partial<MentorSettings>; data?: Partial<MentorData> }

export default class MentorPlugin extends Plugin {
  settings: MentorSettings = { ...DEFAULTS };
  data: MentorData = structuredClone(EMPTY_DATA);
  claude = new ClaudeRunner(() => ({ cliPath: this.settings.cliPath, model: this.settings.model }));
  scheduler!: Scheduler;
  private status: HTMLElement | null = null;

  async onload() {
    const saved = ((await this.loadData()) ?? {}) as Saved;
    this.settings = { ...DEFAULTS, ...saved.settings };
    if (this.settings.model !== 'opus') this.settings.model = 'sonnet';
    if (!['auto', 'fr', 'en'].includes(this.settings.language)) this.settings.language = 'auto';
    setLanguage(this.settings.language);
    delete (this.settings as unknown as Record<string, unknown>).gradeModel;
    this.data = { ...structuredClone(EMPTY_DATA), ...saved.data };
    for (const c of Object.values(this.data.cards)) c.fsrs = normalizeCard(c.fsrs);
    this.scheduler = await Scheduler.create(this.settings.retention);

    this.registerView(VIEW_TYPE, (leaf) => new MentorView(leaf, this));
    this.addRibbonIcon('graduation-cap', 'Mentor', () => void this.open());
    this.addCommand({ id: 'open', name: tr('Ouvrir l’accueil', 'Open home'), callback: () => void this.open() });
    this.addCommand({ id: 'lesson-active', name: tr('Leçon guidée sur la note active', 'Guided lesson on the active note'), callback: () => this.pickActive('lesson') });
    this.addCommand({ id: 'quiz-active', name: tr('Quiz sur la note active', 'Quiz on the active note'), callback: () => this.pickActive('quiz') });
    this.addCommand({ id: 'challenge-active', name: tr('Défi chrono sur la note active', 'Timed challenge on the active note'), callback: () => this.pickActive('challenge') });
    this.addCommand({ id: 'pick', name: tr('Apprendre une note ou un dossier…', 'Learn a note or a folder…'), callback: () => this.pickAny() });
    this.addCommand({ id: 'review', name: tr('Réviser les fiches du jour', 'Review today’s cards'), callback: () => void this.open().then(v => v?.review()) });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      menu.addItem(i => i.setTitle(tr('Mentor : leçon guidée', 'Mentor: guided lesson')).setIcon('graduation-cap').onClick(() => void this.startFrom(file, 'lesson')));
      menu.addItem(i => i.setTitle(tr('Mentor : quiz', 'Mentor: quiz')).setIcon('list-checks').onClick(() => void this.startFrom(file, 'quiz')));
      menu.addItem(i => i.setTitle(tr('Mentor : défi chrono', 'Mentor: timed challenge')).setIcon('timer').onClick(() => void this.startFrom(file, 'challenge')));
    }));
    this.addSettingTab(new MentorSettingTab(this.app, this));

    this.status = this.addStatusBarItem();
    this.status.addClass('mentor-status');
    this.status.onClickEvent(() => void this.open().then(v => v?.review()));
    this.app.workspace.onLayoutReady(() => {
      this.updateStatus();
      if (!this.settings.cliPath) void detectClaude().then(async (p) => { if (p) { this.settings.cliPath = p; await this.saveAll(); } });
    });
    this.registerInterval(window.setInterval(() => this.updateStatus(), 10 * 60 * 1000));
  }

  async saveAll() { await this.saveData({ settings: this.settings, data: this.data }); }

  updateStatus() {
    if (!this.status) return;
    const n = reviewQueue(this.data, this.settings.newPerDay).length;
    this.status.setText(n ? `Mentor · ${n} ${tr('à réviser', 'to review')}` : '');
    this.status.toggle(n > 0);
  }

  async open(): Promise<MentorView | null> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) { leaf = this.app.workspace.getLeaf('tab'); await leaf.setViewState({ type: VIEW_TYPE, active: true }); }
    await this.app.workspace.revealLeaf(leaf);
    return leaf.view instanceof MentorView ? leaf.view : null;
  }

  ensureTopic(kind: TopicKind, ref: string, title: string): Topic {
    const id = topicId(kind, ref);
    const t = this.data.topics[id] ??= { id, title, kind, ref, created: new Date().toISOString(), concepts: {}, lessons: 0 };
    return t;
  }

  addCards(topic: Topic, cards: { front: string; back: string; concept: string; source: string }[]): number {
    const existing = new Set(Object.values(this.data.cards).filter(c => c.topicId === topic.id).map(c => c.front.trim().toLowerCase()));
    let n = 0;
    for (const c of cards) {
      if (!c.front?.trim() || !c.back?.trim() || existing.has(c.front.trim().toLowerCase())) continue;
      const id = uid();
      this.data.cards[id] = { id, topicId: topic.id, front: c.front.trim(), back: c.back.trim(), concept: c.concept || tr('Général', 'General'), source: c.source || '', created: new Date().toISOString(), fsrs: this.scheduler.newCard() };
      existing.add(c.front.trim().toLowerCase());
      n++;
    }
    void this.saveAll();
    this.updateStatus();
    return n;
  }

  async saveSummary(topic: Topic, summary: string): Promise<TFile | null> {
    const folder = normalizePath(this.settings.summaryFolder || 'Mentor');
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    const date = new Date().toISOString().slice(0, 10);
    const safe = topic.title.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    let path = normalizePath(`${folder}/${date} - ${safe}.md`);
    for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${folder}/${date} - ${safe} (${i}).md`);
    const front = `---\ntype: ${tr('synthese-mentor', 'mentor-summary')}\n${tr('sujet', 'topic')}: "${topic.title.replace(/"/g, "'")}"\ndate: ${date}\n---\n\n`;
    try { return await this.app.vault.create(path, front + summary); } catch (e) { new Notice(`${tr('Enregistrement impossible : ', 'Could not save: ')}${(e as Error).message}`); return null; }
  }

  pickActive(mode: 'lesson' | 'quiz' | 'challenge' = 'lesson') {
    const f = this.app.workspace.getActiveFile();
    if (!f) { new Notice(tr('Ouvre d’abord une note de cours.', 'Open a note first.')); return; }
    void this.startFrom(f, mode);
  }

  pickAny() { new PickModal(this.app, (f, mode) => void this.startFrom(f, mode)).open(); }

  async startFrom(f: TAbstractFile, mode: 'lesson' | 'quiz' | 'challenge') {
    const view = await this.open();
    if (!view) return;
    if (f instanceof TFile) await view.startTopic({ kind: 'note', ref: f.path, title: f.basename }, mode);
    else if (f instanceof TFolder) await view.startTopic({ kind: 'folder', ref: f.path, title: f.name || 'Vault' }, mode);
  }
}

class PickModal extends FuzzySuggestModal<TAbstractFile> {
  private mode: 'lesson' | 'quiz' = 'lesson';
  constructor(app: App, private onPick: (f: TAbstractFile, mode: 'lesson' | 'quiz') => void) {
    super(app);
    this.setPlaceholder(tr('Une note ou un dossier de cours… (Maj+Entrée : quiz au lieu de leçon)', 'A note or a folder… (Shift+Enter: quiz instead of lesson)'));
    this.setInstructions([{ command: '↵', purpose: tr('leçon guidée', 'guided lesson') }, { command: tr('Maj ↵', 'Shift ↵'), purpose: 'quiz' }]);
    this.scope.register(['Shift'], 'Enter', (e) => { this.mode = 'quiz'; (this as unknown as { chooser: { useSelectedItem(e: KeyboardEvent): void } }).chooser.useSelectedItem(e); return false; });
  }
  getItems(): TAbstractFile[] {
    const all = this.app.vault.getAllLoadedFiles().filter(f => (f instanceof TFile && f.extension === 'md') || (f instanceof TFolder && f.path !== '/'));
    return all.sort((a, b) => (a instanceof TFolder ? 0 : 1) - (b instanceof TFolder ? 0 : 1) || a.path.localeCompare(b.path));
  }
  getItemText(f: TAbstractFile): string { return f instanceof TFolder ? `${f.path}/` : f.path.replace(/\.md$/, ''); }
  onChooseItem(f: TAbstractFile) { this.onPick(f, this.mode); }
}

const CHOICES = {
  language: () => ({ auto: tr('Automatique', 'Automatic'), fr: 'Français', en: 'English' }),
  model: () => ({ sonnet: 'Sonnet', opus: 'Opus' }),
  retention: () => ({ '0.85': '85 %', '0.9': '90 %', '0.95': '95 %' }),
  budget: () => ({ '60000': tr('Réduite (60 k)', 'Small (60k)'), '120000': tr('Normale (120 k)', 'Normal (120k)'), '250000': tr('Large (250 k)', 'Large (250k)') }),
};

const T = {
  language: () => tr('Langue', 'Language'),
  languageDesc: () => tr('Automatique : celle d’Obsidian. Recharge le plugin après un changement.', 'Automatic: Obsidian’s language. Reload the plugin after a change.'),
  cli: () => tr('Chemin de Claude Code', 'Claude Code path'),
  cliDesc: () => tr('Le programme claude installé sur cet ordinateur. Laisse vide pour le détecter.', 'The claude program installed on this computer. Leave empty to detect it.'),
  model: () => tr('Modèle', 'Model'),
  modelDesc: () => tr('Utilisé pour tout : leçons, quiz, corrections et fiches. Sonnet est rapide et très bon pour enseigner ; Opus va plus en profondeur mais répond plus lentement.', 'Used for everything: lessons, quizzes, grading and cards. Sonnet is fast and very good at teaching; Opus goes deeper but answers more slowly.'),
  learning: () => tr('Apprentissage', 'Learning'),
  learner: () => tr('Qui apprend', 'About you'),
  learnerDesc: () => tr('Ton niveau, ta filière, tes projets : Mentor s’en sert pour choisir ses exemples et son niveau d’exigence.', 'Your level, field and projects: Mentor uses them to pick its examples and how demanding to be.'),
  learnerPh: () => tr('Ex. Étudiant en master génie logiciel, je connais déjà Java et SQL, je prépare un examen…', 'E.g. Software engineering student, I already know Java and SQL, preparing for an exam…'),
  general: () => tr('Compléter hors des notes', 'Go beyond the notes'),
  generalDesc: () => tr('Si tes notes sont incomplètes, Mentor peut compléter avec ses connaissances, en le signalant toujours « (hors de tes notes) ».', 'If your notes are incomplete, Mentor can fill gaps with general knowledge, always marked “(not in your notes)”.'),
  quizSize: () => tr('Questions par quiz', 'Questions per quiz'),
  newPerDay: () => tr('Nouvelles fiches par jour', 'New cards per day'),
  newPerDayDesc: () => tr('Au-delà, les nouvelles fiches attendent le lendemain : la révision reste tenable chaque jour.', 'Beyond this, new cards wait for the next day, so daily review stays manageable.'),
  retention: () => tr('Taux de rappel visé', 'Target retention'),
  retentionDesc: () => tr('FSRS planifie chaque fiche pour que tu t’en souviennes avec cette probabilité. 90 % est le bon compromis ; plus haut = beaucoup plus de révisions.', 'FSRS schedules each card so you remember it with this probability. 90% is a good balance; higher means many more reviews.'),
  budget: () => tr('Quantité de notes envoyées', 'Amount of notes sent'),
  budgetDesc: () => tr('Taille maximale du contexte donné à Claude (en caractères). Plus grand = plus complet mais plus lent.', 'Maximum size of the context given to Claude (in characters). Larger is more complete but slower.'),
  exclude: () => tr('Dossiers ignorés', 'Ignored folders'),
  excludeDesc: () => tr('Un par ligne.', 'One per line.'),
  summary: () => tr('Dossier des synthèses', 'Summaries folder'),
  summaryDesc: () => tr('Où enregistrer les synthèses de séance quand tu le demandes.', 'Where lesson summaries are saved when you ask for it.'),
};

class MentorSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: MentorPlugin) { super(app, plugin); }

  // Declarative settings (Obsidian 1.13+, searchable). display() below stays for older versions.
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      { name: T.language(), desc: T.languageDesc(), control: { type: 'dropdown', key: 'language', options: CHOICES.language() } },
      {
        type: 'group', heading: 'Claude Code',
        items: [
          { name: T.cli(), desc: T.cliDesc(), aliases: ['claude', 'cli'], render: (setting: Setting) => this.cliRow(setting) },
          { name: T.model(), desc: T.modelDesc(), control: { type: 'dropdown', key: 'model', options: CHOICES.model() } },
        ],
      },
      {
        type: 'group', heading: T.learning(),
        items: [
          { name: T.learner(), desc: T.learnerDesc(), control: { type: 'textarea', key: 'learner', placeholder: T.learnerPh(), rows: 4 } },
          { name: T.general(), desc: T.generalDesc(), control: { type: 'toggle', key: 'allowGeneral' } },
          { name: T.quizSize(), control: { type: 'slider', key: 'quizSize', min: 4, max: 20, step: 1 } },
          { name: T.newPerDay(), desc: T.newPerDayDesc(), control: { type: 'slider', key: 'newPerDay', min: 5, max: 60, step: 5 } },
          { name: T.retention(), desc: T.retentionDesc(), control: { type: 'dropdown', key: 'retention', options: CHOICES.retention() } },
        ],
      },
      {
        type: 'group', heading: 'Notes',
        items: [
          { name: T.budget(), desc: T.budgetDesc(), control: { type: 'dropdown', key: 'budget', options: CHOICES.budget() } },
          { name: T.exclude(), desc: T.excludeDesc(), control: { type: 'textarea', key: 'exclude' } },
          { name: T.summary(), desc: T.summaryDesc(), control: { type: 'text', key: 'summaryFolder' } },
        ],
      },
    ];
  }

  getControlValue(key: string): unknown {
    const s = this.plugin.settings;
    switch (key) {
      case 'exclude': return s.exclude.join('\n');
      case 'retention': case 'budget': return String(s[key]);
      case 'language': case 'model': case 'learner': case 'summaryFolder': case 'allowGeneral': case 'quizSize': case 'newPerDay': return s[key];
      default: return undefined;
    }
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings;
    const text = typeof value === 'string' ? value : '';
    switch (key) {
      case 'language': if (value === 'auto' || value === 'fr' || value === 'en') s.language = value; break;
      case 'model': s.model = value === 'opus' ? 'opus' : 'sonnet'; break;
      case 'learner': s.learner = text; break;
      case 'allowGeneral': s.allowGeneral = value === true; break;
      case 'quizSize': case 'newPerDay': if (typeof value === 'number' && Number.isFinite(value)) s[key] = value; break;
      case 'retention': { const r = Number(value); if ([0.85, 0.9, 0.95].includes(r)) { s.retention = r; this.plugin.scheduler = await Scheduler.create(r); } break; }
      case 'budget': { const b = Number(value); if (b > 0) s.budget = b; break; }
      case 'exclude': s.exclude = text.split('\n').map(x => x.trim()).filter(Boolean); break;
      case 'summaryFolder': s.summaryFolder = text.trim() || 'Mentor'; break;
      default: return;
    }
    await this.plugin.saveAll();
    if (key === 'newPerDay') this.plugin.updateStatus();
  }

  /** Path of the claude program, with Detect and Test buttons. */
  private cliRow(setting: Setting) {
    const s = this.plugin.settings;
    const save = () => this.plugin.saveAll();
    setting
      .addText(t => t.setPlaceholder(process.platform === 'win32' ? 'C:\\Users\\…\\.local\\bin\\claude.exe' : '~/.local/bin/claude').setValue(s.cliPath).onChange(async v => { s.cliPath = v.trim(); await save(); }))
      .addButton(b => b.setButtonText(tr('Détecter', 'Detect')).onClick(async () => {
        const p = await detectClaude();
        if (p) { s.cliPath = p; await save(); new Notice(`${tr('Claude Code trouvé : ', 'Claude Code found: ')}${p}`); this.rerender(); } else new Notice(tr('Claude Code introuvable. Installe-le ou indique son chemin.', 'Claude Code not found. Install it or enter its path.'));
      }))
      .addButton(b => b.setButtonText(tr('Tester', 'Test')).setCta().onClick(async () => {
        b.setDisabled(true); b.setButtonText(tr('Test…', 'Testing…'));
        try {
          const r = await this.plugin.claude.run({ system: tr('Réponds en français, en une phrase courte.', 'Answer in English, in one short sentence.'), prompt: tr('Dis bonjour et confirme que tu es prêt à aider un étudiant.', 'Say hello and confirm you are ready to help a student.') });
          new Notice(`${tr('Claude répond : ', 'Claude says: ')}${r.text.slice(0, 160)}`, 8000);
        } catch (e) { new Notice((e as Error).message, 10000); }
        b.setDisabled(false); b.setButtonText(tr('Tester', 'Test'));
      }));
    setting.descEl.createDiv({ cls: 'mentor-dim', text: s.cliPath ? `${tr('Actuel : ', 'Current: ')}${s.cliPath}` : tr('Non trouvé pour l’instant.', 'Not found yet.') });
  }

  /** Obsidian 1.13+: update() re-renders the definitions; older versions: display(). */
  private rerender() {
    const tab = this as unknown as { update?: () => void };
    if (typeof tab.update === 'function') tab.update(); else this.display();
  }

  /** Fallback for Obsidian versions older than 1.13. */
  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const dropdown = (setting: Setting, key: keyof typeof CHOICES) => setting.addDropdown(d => {
      for (const [k, v] of Object.entries(CHOICES[key]())) d.addOption(k, v);
      d.setValue(String(this.getControlValue(key))).onChange(v => this.setControlValue(key, v));
    });

    dropdown(new Setting(containerEl).setName(T.language()).setDesc(T.languageDesc()), 'language');
    new Setting(containerEl).setName('Claude Code').setHeading();
    this.cliRow(new Setting(containerEl).setName(T.cli()).setDesc(T.cliDesc()));
    dropdown(new Setting(containerEl).setName(T.model()).setDesc(T.modelDesc()), 'model');

    new Setting(containerEl).setName(T.learning()).setHeading();
    new Setting(containerEl).setName(T.learner()).setDesc(T.learnerDesc())
      .addTextArea(t => { t.setPlaceholder(T.learnerPh()).setValue(s.learner).onChange(v => this.setControlValue('learner', v)); t.inputEl.rows = 4; });
    new Setting(containerEl).setName(T.general()).setDesc(T.generalDesc()).addToggle(t => t.setValue(s.allowGeneral).onChange(v => this.setControlValue('allowGeneral', v)));
    new Setting(containerEl).setName(T.quizSize()).addSlider(sl => sl.setLimits(4, 20, 1).setValue(s.quizSize).onChange(v => this.setControlValue('quizSize', v)));
    new Setting(containerEl).setName(T.newPerDay()).setDesc(T.newPerDayDesc()).addSlider(sl => sl.setLimits(5, 60, 5).setValue(s.newPerDay).onChange(v => this.setControlValue('newPerDay', v)));
    dropdown(new Setting(containerEl).setName(T.retention()).setDesc(T.retentionDesc()), 'retention');

    new Setting(containerEl).setName('Notes').setHeading();
    dropdown(new Setting(containerEl).setName(T.budget()).setDesc(T.budgetDesc()), 'budget');
    new Setting(containerEl).setName(T.exclude()).setDesc(T.excludeDesc()).addTextArea(t => t.setValue(s.exclude.join('\n')).onChange(v => this.setControlValue('exclude', v)));
    new Setting(containerEl).setName(T.summary()).setDesc(T.summaryDesc()).addText(t => t.setValue(s.summaryFolder).onChange(v => this.setControlValue('summaryFolder', v)));
  }
}
