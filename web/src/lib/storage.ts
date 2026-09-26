// Per-browser conveniences (mode, preferences, toggles). Never required for the app to work.
export const storage = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(`mr.${key}`);
      return v === null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(`mr.${key}`, JSON.stringify(value));
    } catch {}
  },
};
