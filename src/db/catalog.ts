// The model catalog (models, per-effort capability scores, speed, live provider stats, profiles) as a
// file that ships with the repo, so a fresh clone routes with the full database without running
// `s1route ingest` (which needs an Artificial Analysis key). Usage data never goes in here: decisions,
// outcomes, feedback, learned calibration, sessions and saved chats stay in the local database.

import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CATALOG_FILE = fileURLToPath(new URL('../../data/catalog.json', import.meta.url));
// Raw benchmark rows stay out: they are the sources' own data (redistribution terms vary). The derived
// capability scores below are what routing uses.
const TABLES = ['models', 'skills', 'variant_metrics', 'provider_stats', 'profiles'] as const;

export interface CatalogFile {
  version: 1;
  exportedAt: string;
  sources: string;
  tables: Record<string, { columns: string[]; rows: unknown[][] }>;
}

type Row = Record<string, unknown>;

export function exportCatalog(db: DatabaseSync): CatalogFile {
  const tables: CatalogFile['tables'] = {};
  for (const t of TABLES) {
    const rows = db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all() as Row[];
    const columns = (db.prepare(`PRAGMA table_info(${t})`).all() as Row[]).map((c) => c.name as string);
    tables[t] = { columns, rows: rows.map((r) => columns.map((c) => r[c] ?? null)) };
  }
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    sources: 'Artificial Analysis (artificialanalysis.ai), LMArena (lmarena.ai), vendor model cards, OpenRouter',
    tables,
  };
}

export function writeCatalog(db: DatabaseSync, file = CATALOG_FILE): CatalogFile {
  const catalog = exportCatalog(db);
  writeFileSync(file, `${JSON.stringify(catalog)}\n`);
  return catalog;
}

export function readCatalog(file = CATALOG_FILE): CatalogFile | undefined {
  if (!existsSync(file)) return undefined;
  const c = JSON.parse(readFileSync(file, 'utf8')) as CatalogFile;
  return c.version === 1 ? c : undefined;
}

export const getMeta = (db: DatabaseSync, key: string) =>
  (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
export const setMeta = (db: DatabaseSync, key: string, value: string) =>
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

// A shipped catalog is newer than what this database has, from an earlier import or a local ingest.
export function catalogIsNewer(db: DatabaseSync, catalog: CatalogFile): boolean {
  const since = [getMeta(db, 'catalog_imported_at'), getMeta(db, 'ingested_at')].filter(Boolean).sort().at(-1);
  return !since || catalog.exportedAt > since;
}

// Replaces the catalog tables. Columns the file doesn't have keep their defaults (older catalogs still
// load after a schema change); the user's own enable/disable choices survive an update.
export function importCatalog(db: DatabaseSync, catalog: CatalogFile): { models: number } {
  const enabled = new Map((db.prepare('SELECT id, enabled FROM models').all() as Row[]).map((r) => [r.id as string, r.enabled as number]));
  db.exec('BEGIN');
  try {
    for (const t of [...TABLES].reverse()) db.exec(`DELETE FROM ${t}`);
    for (const t of TABLES) {
      const data = catalog.tables[t];
      if (!data?.rows.length) continue;
      const known = new Set((db.prepare(`PRAGMA table_info(${t})`).all() as Row[]).map((c) => c.name as string));
      const idx = data.columns.map((c, i) => [c, i] as const).filter(([c]) => known.has(c));
      const insert = db.prepare(`INSERT OR REPLACE INTO ${t} (${idx.map(([c]) => c).join(', ')}) VALUES (${idx.map(() => '?').join(', ')})`);
      for (const row of data.rows) insert.run(...(idx.map(([, i]) => row[i] ?? null) as never[]));
    }
    const restore = db.prepare('UPDATE models SET enabled = ? WHERE id = ?');
    for (const [id, on] of enabled) restore.run(on, id);
    setMeta(db, 'catalog_imported_at', catalog.exportedAt);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { models: catalog.tables.models?.rows.length ?? 0 };
}
