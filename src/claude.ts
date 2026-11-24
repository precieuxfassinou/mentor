import { execFile, spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { tr } from './i18n';

/**
 * Runs the local Claude Code CLI in print mode, with no tools: Mentor passes the notes itself
 * and Claude only reads and writes text. Uses the user's existing Claude Code login.
 */

export interface ClaudeCall {
  system: string;
  prompt: string;
  /** JSON schema: when set, the answer is validated JSON (structured_output). */
  schema?: Record<string, unknown>;
  /** Streaming: called with the full text received so far. */
  onText?: (full: string) => void;
  signal?: AbortSignal;
  model?: string;
}

export interface ClaudeResult { text: string; structured?: unknown }

interface StreamLine {
  type?: string;
  event?: { type?: string; delta?: { type?: string; text?: string } };
  message?: { content?: { type?: string; text?: string }[] };
  result?: string;
  is_error?: boolean;
  structured_output?: unknown;
}

const TIMEOUT_MS = 6 * 60 * 1000;

export function candidatePaths(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    return [
      path.join(home, '.local', 'bin', 'claude.exe'),
      path.join(local, 'Programs', 'claude', 'claude.exe'),
      path.join(local, 'AnthropicClaude', 'claude.exe'),
      path.join(appData, 'npm', 'claude.cmd'),
    ];
  }
  return [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
}

type Cmd = { cmd: string; pre: string[]; env: NodeJS.ProcessEnv };

/** An npm install leaves a .cmd shim: run its cli.js with Obsidian's own Node instead of going through cmd.exe. */
function command(cli: string): Cmd {
  if (/\.(cmd|bat)$/i.test(cli)) {
    const js = path.join(path.dirname(cli), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    return { cmd: process.execPath, pre: [js], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } };
  }
  return { cmd: cli, pre: [], env: { ...process.env } };
}

/** True when this path runs Claude Code (`claude --version` answers). No direct file access needed. */
function works(cli: string): Promise<boolean> {
  const c = command(cli);
  return new Promise((resolve) => {
    execFile(c.cmd, [...c.pre, '--version'], { env: c.env, timeout: 15000, windowsHide: true }, (err) => resolve(!err));
  });
}

/** Finds the claude executable: known install locations first, then the system PATH. */
export async function detectClaude(): Promise<string | null> {
  for (const p of candidatePaths()) if (await works(p)) return p;
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const found = await new Promise<string[]>((resolve) => {
    execFile(finder, ['claude'], { timeout: 5000, windowsHide: true }, (err, out) => {
      resolve(err ? [] : String(out).split(/\r?\n/).map(x => x.trim()).filter(Boolean));
    });
  });
  for (const p of found) if (await works(p)) return p;
  return null;
}

/** Fixed short system prompt; Mentor's full instructions travel in the message (stdin), so no temporary file is written. */
const ROLE = 'You are Mentor, a study tutor inside Obsidian. The message starts with your complete instructions inside <instructions> tags, followed by the task. Follow those instructions exactly; never mention the tags.';

export class ClaudeRunner {
  constructor(private cfg: () => { cliPath: string; model: string }) {}

  run(call: ClaudeCall): Promise<ClaudeResult> {
    const { cliPath, model } = this.cfg();
    if (!cliPath) return Promise.reject(new Error(tr('Claude Code est introuvable. Indique son chemin dans les réglages de Mentor.', 'Claude Code was not found. Enter its path in Mentor’s settings.')));
    const cmd = command(cliPath);
    // Neutral working directory: no CLAUDE.md or project settings from the vault get loaded.
    const dir = os.tmpdir();

    const structured = !!call.schema;
    const args = [
      ...cmd.pre, '-p',
      '--output-format', structured ? 'json' : 'stream-json',
      ...(structured ? ['--json-schema', JSON.stringify(call.schema)] : ['--verbose', '--include-partial-messages']),
      '--system-prompt', ROLE,
      '--tools', '',
      '--model', call.model || model || 'sonnet',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--strict-mcp-config',
    ];

    return new Promise<ClaudeResult>((resolve, reject) => {
      const child = spawn(cmd.cmd, args, { cwd: dir, env: cmd.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let buf = '';
      let err = '';
      let full = '';
      let final: StreamLine | null = null;
      let settled = false;

      const finish = (fn: () => void) => { if (settled) return; settled = true; window.clearTimeout(timer); fn(); };
      const timer = window.setTimeout(() => { child.kill(); finish(() => reject(new Error(tr('Claude met trop de temps à répondre (6 min). Réessaie.', 'Claude is taking too long to answer (6 min). Try again.')))); }, TIMEOUT_MS);
      call.signal?.addEventListener('abort', () => { child.kill(); finish(() => reject(new Error(tr('Annulé.', 'Cancelled.')))); });

      const handle = (line: string) => {
        if (!line.trim()) return;
        let msg: StreamLine;
        try { msg = JSON.parse(line) as StreamLine; } catch { return; }
        if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta' && msg.event.delta?.type === 'text_delta') {
          full += msg.event.delta.text ?? '';
          call.onText?.(full);
        } else if (msg.type === 'assistant' && !full) {
          // Without partial events: whole message at once.
          const text = (msg.message?.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('');
          if (text) { full = text; call.onText?.(full); }
        } else if (msg.type === 'result') {
          final = msg;
        }
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => {
        if (structured) { out += d; return; }
        buf += d;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d: string) => { err = (err + d).slice(-4000); });
      child.on('error', (e) => finish(() => reject(new Error(tr(`Impossible de lancer Claude Code (${cliPath}) : ${e.message}`, `Could not start Claude Code (${cliPath}): ${e.message}`)))));
      child.on('close', (code) => {
        if (!structured && buf) handle(buf);
        if (structured) {
          const lines = out.split(/\r?\n/).filter(l => l.trim().startsWith('{'));
          for (const l of lines) { try { const m = JSON.parse(l) as StreamLine; if (m.type === 'result') final = m; } catch { /* not JSON */ } }
        }
        const res: StreamLine | null = final;
        if (res && !res.is_error) {
          return finish(() => resolve({ text: res.result ?? full, structured: res.structured_output }));
        }
        const reason = res?.result || err.trim().split('\n').slice(-3).join(' ') || `code ${code}`;
        finish(() => reject(new Error(friendly(reason))));
      });

      child.stdin.on('error', () => { /* process ended early: reported by close */ });
      child.stdin.end(`<instructions>\n${call.system}\n</instructions>\n\n${call.prompt}`, 'utf8');
    });
  }

  /** Structured call: returns the validated JSON, or tries to read JSON from the text. */
  async json<T>(call: ClaudeCall & { schema: Record<string, unknown> }): Promise<T> {
    const r = await this.run(call);
    if (r.structured && typeof r.structured === 'object') return r.structured as T;
    const m = r.text.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]) as T; } catch { /* fall through */ } }
    throw new Error(tr('Réponse de Claude illisible. Réessaie.', 'Unreadable answer from Claude. Try again.'));
  }
}

function friendly(reason: string): string {
  if (/auth|login|log in|credential|401/i.test(reason)) return tr('Claude Code n’est pas connecté. Ouvre un terminal, lance « claude » et connecte-toi, puis réessaie.', 'Claude Code is not signed in. Open a terminal, run “claude” and sign in, then try again.');
  if (/rate|limit|429|usage/i.test(reason)) return `${tr('Limite d’utilisation atteinte : ', 'Usage limit reached: ')}${reason}`;
  if (/ENOTFOUND|ECONN|network|fetch failed|timed out/i.test(reason)) return tr('Pas de connexion à Claude (réseau). Vérifie Internet et réessaie.', 'Cannot reach Claude (network). Check your connection and try again.');
  return `Claude Code : ${reason}`;
}
