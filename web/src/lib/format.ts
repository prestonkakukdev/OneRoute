export const pct = (p?: number | null) => `${Math.round((p ?? 0) * 100)}%`;
export const usd = (v?: number | null) =>
  v === undefined || v === null ? '–' : Math.abs(v) < 0.01 ? `$${v.toFixed(5)}` : `$${v.toFixed(3)}`;
export const secs = (v?: number | null) => (v === undefined || v === null ? '–' : `${v.toFixed(1)}s`);
export const shortModel = (id?: string) => (id ?? '').split('/')[1] || id || '';
export const label = (k: string | number) => String(k).replace(/_/g, ' ');
export const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
