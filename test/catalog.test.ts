import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type CatalogFile, catalogIsNewer, exportCatalog, importCatalog, readCatalog } from '../src/db/catalog.js';
import { Store } from '../src/db/store.js';

const tmpDb = () => join(mkdtempSync(join(tmpdir(), 'catalog-')), 'router.db');

describe('shipped model catalog', () => {
  it('gives a fresh install the full model database', () => {
    const shipped = readCatalog();
    expect(shipped, 'data/catalog.json should ship with the repo').toBeDefined();
    const store = new Store(tmpDb());
    expect(store.listModels({ includeDisabled: true }).length).toBe(shipped!.tables.models!.rows.length);
    expect(store.listModels().length).toBeGreaterThan(20);
    store.close();
  });

  it('contains model data only, never usage', () => {
    const tables = Object.keys(readCatalog()!.tables);
    expect(tables.sort()).toEqual(['models', 'profiles', 'provider_stats', 'skills', 'variant_metrics']);
  });

  it('updates to a newer catalog, keeps the user’s enable/disable choices, and never overwrites a newer local ingest', () => {
    const source = new Store(':memory:');
    const catalog: CatalogFile = { ...exportCatalog(source.db), exportedAt: '2026-01-01T00:00:00.000Z' };
    const [first] = source.listModels();

    const store = new Store(':memory:', { catalog: false });
    importCatalog(store.db, catalog);
    store.setEnabled(first!.id, false);
    expect(catalogIsNewer(store.db, catalog)).toBe(false);

    const newer = { ...catalog, exportedAt: '2026-02-01T00:00:00.000Z' };
    expect(catalogIsNewer(store.db, newer)).toBe(true);
    importCatalog(store.db, newer);
    expect(store.listModels({ includeDisabled: true }).find((m) => m.id === first!.id)?.enabled).toBe(false);

    store.setMeta('ingested_at', '2026-03-01T00:00:00.000Z');
    expect(catalogIsNewer(store.db, { ...catalog, exportedAt: '2026-02-15T00:00:00.000Z' })).toBe(false);
  });
});
