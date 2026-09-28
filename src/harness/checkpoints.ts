// Checkpoints: before the agent changes a file, its original is saved, once per session (for the session's diff and
// "undo everything") and once per turn (so the files can be put back to how they were before any message).
//
// Layout under ~/.oneroute/snapshots/<session>/:
//   session/manifest.json + session/files/…     originals as they were before the session first touched them
//   turns/<turn>/manifest.json + …/files/…      originals as they were before that turn first touched them
// A manifest maps each relative path to 'saved' (the original is in files/) or 'absent' (the file didn't exist).

import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { DiffFile } from './workspace.js';
import { git, listProjectFiles } from './workspace.js';

export const SNAPSHOTS_DIR = join(homedir(), '.oneroute', 'snapshots');

type Manifest = Record<string, 'saved' | 'absent'>;

// One set of originals (the session's, or one turn's).
class SnapshotSet {
  constructor(readonly dir: string) {}

  private get manifestPath() {
    return join(this.dir, 'manifest.json');
  }

  read(): Manifest {
    try {
      const raw = JSON.parse(readFileSync(this.manifestPath, 'utf8')) as Manifest | { files: Manifest };
      // Sessions from before turns existed stored { files: {...} }.
      return 'files' in raw && typeof raw.files === 'object' ? (raw.files as Manifest) : (raw as Manifest);
    } catch {
      return {};
    }
  }

  // Records the original of `rel` unless it is already recorded. `original` is the file's current content (or a
  // path to copy it from), or null when it doesn't exist.
  record(rel: string, original: { copyFrom: string } | { content: Buffer } | null): void {
    const manifest = this.read();
    if (manifest[rel]) return;
    if (original) {
      const dest = join(this.dir, 'files', rel);
      mkdirSync(dirname(dest), { recursive: true });
      if ('copyFrom' in original) copyFileSync(original.copyFrom, dest);
      else writeFileSync(dest, original.content);
      manifest[rel] = 'saved';
    } else manifest[rel] = 'absent';
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.manifestPath, JSON.stringify(manifest));
  }

  original(rel: string): string | null {
    return this.read()[rel] === 'saved' ? join(this.dir, 'files', rel) : null;
  }

  // Puts every recorded file back; returns how many.
  restore(folder: string): number {
    let n = 0;
    for (const [rel, state] of Object.entries(this.read())) {
      const current = join(folder, rel);
      if (state === 'saved') {
        mkdirSync(dirname(current), { recursive: true });
        copyFileSync(join(this.dir, 'files', rel), current);
      } else if (existsSync(current)) rmSync(current);
      n += 1;
    }
    return n;
  }

  drop(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

async function noIndexDiff(folder: string, a: string, b: string, args: string[]): Promise<string> {
  try {
    return await git(folder, ['diff', '--no-index', ...args, '--', a, b]);
  } catch (err) {
    // git diff --no-index exits 1 when the files differ.
    return (err as { stdout?: string }).stdout ?? '';
  }
}

export class Checkpoints {
  private readonly root: string;
  private turn: number | undefined;

  constructor(
    readonly sessionId: string,
    readonly folder: string,
  ) {
    this.root = join(SNAPSHOTS_DIR, sessionId);
  }

  private get session(): SnapshotSet {
    // Sessions from before turns existed kept the session's manifest at the root.
    return new SnapshotSet(existsSync(join(this.root, 'manifest.json')) ? this.root : join(this.root, 'session'));
  }

  private turnSet(turn: number): SnapshotSet {
    return new SnapshotSet(join(this.root, 'turns', String(turn)));
  }

  // The turn (the seq of the user's message) that following changes belong to.
  beginTurn(turn: number): void {
    this.turn = turn;
  }

  private record(rel: string, original: { copyFrom: string } | { content: Buffer } | null): void {
    this.session.record(rel, original);
    if (this.turn !== undefined) this.turnSet(this.turn).record(rel, original);
  }

  // Called by the edit tools before they write a file.
  beforeWrite(fullPath: string): void {
    this.record(relative(this.folder, fullPath), existsSync(fullPath) ? { copyFrom: fullPath } : null);
  }

  // Changes made by shell commands. In a git folder, files that were clean before the command get their original
  // from the last commit, and new untracked files are recorded as new. Elsewhere only new files can be recorded.
  async beforeCommand(): Promise<() => Promise<void>> {
    const isGit = await git(this.folder, ['rev-parse', '--is-inside-work-tree']).then(
      (o) => o.trim() === 'true',
      () => false,
    );
    if (isGit) {
      const before = await dirtyPaths(this.folder);
      return async () => {
        const after = await dirtyPaths(this.folder);
        for (const [rel, code] of after) {
          if (before.has(rel)) continue;
          if (code === '??') this.record(rel, null);
          else {
            const content = await gitShow(this.folder, rel);
            this.record(rel, content === null ? null : { content });
          }
        }
      };
    }
    const before = new Set(await listProjectFiles(this.folder));
    return async () => {
      for (const rel of await listProjectFiles(this.folder)) if (!before.has(rel)) this.record(rel, null);
    };
  }

  // How many files a turn changed.
  turnFiles(turn: number): number {
    return Object.keys(this.turnSet(turn).read()).length;
  }

  // Turns that changed files, oldest first.
  turns(): number[] {
    const dir = join(this.root, 'turns');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map(Number)
      .filter((n) => Number.isFinite(n) && Object.keys(this.turnSet(n).read()).length > 0)
      .sort((a, b) => a - b);
  }

  // Puts the files back to how they were before `turn`, undoing that turn and every later one (newest first).
  restoreTo(turn: number): number {
    const touched = new Set<string>();
    for (const t of this.turns()
      .filter((t) => t >= turn)
      .reverse()) {
      const set = this.turnSet(t);
      for (const rel of Object.keys(set.read())) touched.add(rel);
      set.restore(this.folder);
      set.drop();
    }
    return touched.size;
  }

  // Everything the session changed, file by file, against the originals.
  async diff(): Promise<{ files: DiffFile[]; patch: string }> {
    const session = this.session;
    const files: DiffFile[] = [];
    const patches: string[] = [];
    for (const rel of Object.keys(session.read())) {
      const before = session.original(rel) ?? '/dev/null';
      const current = join(this.folder, rel);
      const after = existsSync(current) ? current : '/dev/null';
      if (before === '/dev/null' && after === '/dev/null') continue;
      const numstat = (await noIndexDiff(this.folder, before, after, ['--numstat'])).trim();
      if (!numstat) continue;
      const [a, r] = numstat.split('\t');
      files.push({ path: rel, added: Number(a) || 0, removed: Number(r) || 0, status: before === '/dev/null' ? 'added' : after === '/dev/null' ? 'deleted' : 'modified' });
      const patch = await noIndexDiff(this.folder, before, after, []);
      // Show project-relative names instead of the snapshot and absolute paths.
      patches.push(patch.replace(/^diff --git .*$/m, `diff --git a/${rel} b/${rel}`).replace(/^--- .*$/m, `--- a/${rel}`).replace(/^\+\+\+ .*$/m, `+++ b/${rel}`));
    }
    return { files, patch: patches.join('') };
  }

  // Undoes everything the session changed.
  undoAll(): number {
    const restored = this.session.restore(this.folder);
    this.drop();
    return restored;
  }

  drop(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

// Paths git reports as changed or untracked, with their status code.
async function dirtyPaths(folder: string): Promise<Map<string, string>> {
  const out = await git(folder, ['status', '--porcelain', '-z', '--untracked-files=all']).catch(() => '');
  const map = new Map<string, string>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    map.set(entry.slice(3), code.trim() || code);
    if (code.startsWith('R') || code.startsWith('C')) i += 1; // the rename's source path follows
  }
  return map;
}

function gitShow(folder: string, rel: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile('git', ['show', `HEAD:${rel}`], { cwd: folder, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
}
