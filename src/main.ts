import { App, FuzzySuggestModal, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, TFolder, normalizePath } from 'obsidian';
import { ClaudeRunner, detectClaude } from './claude';
import { EMPTY_DATA, Scheduler, reviewQueue, topicId, uid, type MentorData, type Topic, type TopicKind } from './store';
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
  scheduler = new Scheduler(0.9);
  private status: HTMLElement | null = null;

  async onload() {
    const saved = ((await this.loadData()) ?? {}) as Saved;
    this.settings = { ...DEFAULTS, ...saved.settings };
    if (this.settings.model !== 'opus') this.settings.model = 'sonnet';
    if (!['auto', 'fr', 'en'].includes(this.settings.language)) this.settings.language = 'auto';
    setLanguage(this.settings.language);
    delete (this.settings as unknown as Record<string, unknown>).gradeModel;
    this.data = { ...structuredClone(EMPTY_DATA), ...saved.data };
    this.scheduler = new Scheduler(this.settings.retention);

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

class MentorSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: MentorPlugin) { super(app, plugin); }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveAll();

    new Setting(containerEl).setName(tr('Langue', 'Language')).setDesc(tr('Automatique : celle d’Obsidian. Recharge le plugin après un changement.', 'Automatic: Obsidian’s language. Reload the plugin after a change.'))
      .addDropdown(d => d.addOption('auto', tr('Automatique', 'Automatic')).addOption('fr', 'Français').addOption('en', 'English').setValue(s.language)
        .onChange(async v => { s.language = v as LangChoice; await save(); }));

    new Setting(containerEl).setName('Claude Code').setHeading();
    const cli = new Setting(containerEl).setName(tr('Chemin de Claude Code', 'Claude Code path'))
      .setDesc(tr('Le programme claude installé sur cet ordinateur. Laisse vide pour le détecter.', 'The claude program installed on this computer. Leave empty to detect it.'))
      .addText(t => t.setPlaceholder(process.platform === 'win32' ? 'C:\\Users\\…\\.local\\bin\\claude.exe' : '~/.local/bin/claude').setValue(s.cliPath).onChange(async v => { s.cliPath = v.trim(); await save(); }))
      .addButton(b => b.setButtonText(tr('Détecter', 'Detect')).onClick(async () => {
        const p = await detectClaude();
        if (p) { s.cliPath = p; await save(); new Notice(`${tr('Claude Code trouvé : ', 'Claude Code found: ')}${p}`); this.display(); } else new Notice(tr('Claude Code introuvable. Installe-le ou indique son chemin.', 'Claude Code not found. Install it or enter its path.'));
      }))
      .addButton(b => b.setButtonText(tr('Tester', 'Test')).setCta().onClick(async () => {
        b.setDisabled(true); b.setButtonText(tr('Test…', 'Testing…'));
        try {
          const r = await this.plugin.claude.run({ system: tr('Réponds en français, en une phrase courte.', 'Answer in English, in one short sentence.'), prompt: tr('Dis bonjour et confirme que tu es prêt à aider un étudiant.', 'Say hello and confirm you are ready to help a student.') });
          new Notice(`${tr('Claude répond : ', 'Claude says: ')}${r.text.slice(0, 160)}`, 8000);
        } catch (e) { new Notice((e as Error).message, 10000); }
        b.setDisabled(false); b.setButtonText(tr('Tester', 'Test'));
      }));
    cli.descEl.createDiv({ cls: 'mentor-dim', text: s.cliPath ? `${tr('Actuel : ', 'Current: ')}${s.cliPath}` : tr('Non trouvé pour l’instant.', 'Not found yet.') });
    new Setting(containerEl).setName(tr('Modèle', 'Model')).setDesc(tr('Utilisé pour tout : leçons, quiz, corrections et fiches. Sonnet est rapide et très bon pour enseigner ; Opus va plus en profondeur mais répond plus lentement.', 'Used for everything: lessons, quizzes, grading and cards. Sonnet is fast and very good at teaching; Opus goes deeper but answers more slowly.'))
      .addDropdown(d => d.addOption('sonnet', 'Sonnet').addOption('opus', 'Opus').setValue(s.model).onChange(async v => { s.model = v; await save(); }));

    new Setting(containerEl).setName(tr('Apprentissage', 'Learning')).setHeading();
    new Setting(containerEl).setName(tr('Qui apprend', 'About you')).setDesc(tr('Ton niveau, ta filière, tes projets : Mentor s’en sert pour choisir ses exemples et son niveau d’exigence.', 'Your level, field and projects: Mentor uses them to pick its examples and how demanding to be.'))
      .addTextArea(t => { t.setPlaceholder(tr('Ex. Étudiant en master génie logiciel, je connais déjà Java et SQL, je prépare un examen…', 'E.g. Software engineering student, I already know Java and SQL, preparing for an exam…')).setValue(s.learner).onChange(async v => { s.learner = v; await save(); }); t.inputEl.rows = 4; });
    new Setting(containerEl).setName(tr('Compléter hors des notes', 'Go beyond the notes')).setDesc(tr('Si tes notes sont incomplètes, Mentor peut compléter avec ses connaissances, en le signalant toujours « (hors de tes notes) ».', 'If your notes are incomplete, Mentor can fill gaps with general knowledge, always marked “(not in your notes)”.'))
      .addToggle(t => t.setValue(s.allowGeneral).onChange(async v => { s.allowGeneral = v; await save(); }));
    new Setting(containerEl).setName(tr('Questions par quiz', 'Questions per quiz'))
      .addSlider(sl => sl.setLimits(4, 20, 1).setValue(s.quizSize).onChange(async v => { s.quizSize = v; await save(); }));
    new Setting(containerEl).setName(tr('Nouvelles fiches par jour', 'New cards per day')).setDesc(tr('Au-delà, les nouvelles fiches attendent le lendemain : la révision reste tenable chaque jour.', 'Beyond this, new cards wait for the next day, so daily review stays manageable.'))
      .addSlider(sl => sl.setLimits(5, 60, 5).setValue(s.newPerDay).onChange(async v => { s.newPerDay = v; await save(); this.plugin.updateStatus(); }));
    new Setting(containerEl).setName(tr('Taux de rappel visé', 'Target retention')).setDesc(tr('FSRS planifie chaque fiche pour que tu t’en souviennes avec cette probabilité. 90 % est le bon compromis ; plus haut = beaucoup plus de révisions.', 'FSRS schedules each card so you remember it with this probability. 90% is a good balance; higher means many more reviews.'))
      .addDropdown(d => d.addOption('0.85', '85 %').addOption('0.9', '90 %').addOption('0.95', '95 %').setValue(String(s.retention)).onChange(async v => { s.retention = Number(v); this.plugin.scheduler = new Scheduler(s.retention); await save(); }));

    new Setting(containerEl).setName('Notes').setHeading();
    new Setting(containerEl).setName(tr('Quantité de notes envoyées', 'Amount of notes sent')).setDesc(tr('Taille maximale du contexte donné à Claude (en caractères). Plus grand = plus complet mais plus lent.', 'Maximum size of the context given to Claude (in characters). Larger is more complete but slower.'))
      .addDropdown(d => d.addOption('60000', tr('Réduite (60 k)', 'Small (60k)')).addOption('120000', tr('Normale (120 k)', 'Normal (120k)')).addOption('250000', tr('Large (250 k)', 'Large (250k)')).setValue(String(s.budget)).onChange(async v => { s.budget = Number(v); await save(); }));
    new Setting(containerEl).setName(tr('Dossiers ignorés', 'Ignored folders')).setDesc(tr('Un par ligne.', 'One per line.'))
      .addTextArea(t => t.setValue(s.exclude.join('\n')).onChange(async v => { s.exclude = v.split('\n').map(x => x.trim()).filter(Boolean); await save(); }));
    new Setting(containerEl).setName(tr('Dossier des synthèses', 'Summaries folder')).setDesc(tr('Où enregistrer les synthèses de séance quand tu le demandes.', 'Where lesson summaries are saved when you ask for it.'))
      .addText(t => t.setValue(s.summaryFolder).onChange(async v => { s.summaryFolder = v.trim() || 'Mentor'; await save(); }));
  }
}
