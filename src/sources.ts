import { App, TFile, TFolder, getLinkpath } from 'obsidian';
import { locale, tr } from './i18n';

/** The notes Mentor gives to Claude for one subject. */
export interface SourceSet {
  title: string;
  files: { path: string; text: string; truncated: boolean }[];
  /** Notes that matched but did not fit in the budget. */
  left: string[];
}

export interface SourceOptions { budget: number; exclude: string[] }

const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const STOP = new Set(('le la les un une des de du d l et ou en au aux a à est sont pour par sur dans que qui quoi comment '
  + 'pourquoi ce cette ces son sa ses mon ma mes ton ta tes the of and or to in is are what how why with sans avec je tu il nous vous '
  + 'explique expliquer apprendre comprendre cours notion notions difference entre '
  + 'a an on at by for from as be it its this that these those do does was were explain learn understand between versus vs').split(' ').map(strip));

function excluded(path: string, exclude: string[]): boolean {
  return exclude.some(e => e && (path === e || path.startsWith(e.replace(/\/$/, '') + '/')));
}

/** Removes frontmatter and long base64 or embedded data that would only waste the budget. */
function clean(text: string): string {
  return text
    .replace(/^---\n[\s\S]*?\n---\n?/, '')
    .replace(/!\[[^\]]*\]\(data:[^)]+\)/g, '[image]')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function readAll(app: App, files: TFile[], budget: number, title: string): Promise<SourceSet> {
  const set: SourceSet = { title, files: [], left: [] };
  let used = 0;
  for (const f of files) {
    const text = clean(await app.vault.cachedRead(f));
    if (!text) continue;
    const room = budget - used;
    if (room < 800) { set.left.push(f.path); continue; }
    const truncated = text.length > room;
    const part = truncated ? text.slice(0, room) : text;
    set.files.push({ path: f.path, text: part, truncated });
    used += part.length;
  }
  return set;
}

/** A note, then the notes it links to, then the notes that link to it. */
export async function fromNote(app: App, file: TFile, o: SourceOptions): Promise<SourceSet> {
  const out: TFile[] = [file];
  const seen = new Set([file.path]);
  const add = (f: TFile | null) => {
    if (f && f.extension === 'md' && !seen.has(f.path) && !excluded(f.path, o.exclude)) { seen.add(f.path); out.push(f); }
  };
  const cache = app.metadataCache.getFileCache(file);
  for (const l of [...(cache?.links ?? []), ...(cache?.embeds ?? [])]) {
    add(app.metadataCache.getFirstLinkpathDest(getLinkpath(l.link), file.path));
  }
  const resolved = app.metadataCache.resolvedLinks;
  for (const [src, targets] of Object.entries(resolved)) {
    if (targets[file.path]) { const f = app.vault.getAbstractFileByPath(src); if (f instanceof TFile) add(f); }
  }
  return readAll(app, out, o.budget, file.basename);
}

/** Every note of a folder, in path order (course chapters are usually numbered). */
export async function fromFolder(app: App, folder: TFolder, o: SourceOptions): Promise<SourceSet> {
  const files: TFile[] = [];
  const walk = (f: TFolder) => {
    for (const c of f.children) {
      if (c instanceof TFolder) walk(c);
      else if (c instanceof TFile && c.extension === 'md' && !excluded(c.path, o.exclude)) files.push(c);
    }
  };
  walk(folder);
  files.sort((a, b) => a.path.localeCompare(b.path, locale(), { numeric: true }));
  return readAll(app, files, o.budget, folder.name);
}

/** A free question: the notes whose title, headings and text best match its words. */
export async function fromQuery(app: App, query: string, o: SourceOptions): Promise<SourceSet> {
  const terms = [...new Set(strip(query).split(/[^a-z0-9#+.]+/).filter(t => t.length > 1 && !STOP.has(t)))];
  if (!terms.length) return { title: query, files: [], left: [] };
  const scored: { f: TFile; s: number }[] = [];
  for (const f of app.vault.getMarkdownFiles()) {
    if (excluded(f.path, o.exclude)) continue;
    const title = strip(f.basename);
    const cache = app.metadataCache.getFileCache(f);
    const heads = strip((cache?.headings ?? []).map(h => h.heading).join(' '));
    const tags = strip((cache?.tags ?? []).map(t => t.tag).join(' '));
    const body = strip(await app.vault.cachedRead(f));
    let s = 0;
    let hit = 0;
    for (const t of terms) {
      const inBody = body.split(t).length - 1;
      const local = (title.includes(t) ? 6 : 0) + (heads.includes(t) ? 3 : 0) + (tags.includes(t) ? 2 : 0) + Math.min(inBody, 12) * 0.5;
      if (local > 0) hit++;
      s += local;
    }
    if (s > 0) scored.push({ f, s: s * (hit / terms.length) * (hit / terms.length) });
  }
  scored.sort((a, b) => b.s - a.s);
  const top = scored.filter(x => x.s >= scored[0]?.s * 0.15).slice(0, 25).map(x => x.f);
  return readAll(app, top, o.budget, query);
}

/** Block given to Claude: every note with its path, so it can cite it. */
export function formatSources(set: SourceSet): string {
  if (!set.files.length) return tr('(Aucune note trouvée dans le vault pour ce sujet.)', '(No note found in the vault for this topic.)');
  const parts = set.files.map(f => `<note path="${f.path}"${f.truncated ? ' truncated="yes"' : ''}>\n${f.text}\n</note>`);
  if (set.left.length) parts.push(`${tr('(Notes liées non incluses faute de place : ', '(Linked notes left out for lack of room: ')}${set.left.slice(0, 20).join(', ')})`);
  return parts.join('\n\n');
}
