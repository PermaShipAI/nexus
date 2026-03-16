class SettingsStore {
  private readonly store = new Map<string, unknown>();

  get(key: string): unknown {
    return this.store.get(key);
  }

  set(key: string, value: unknown): void {
    this.store.set(key, value);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }
}

export const settingsStore = new SettingsStore();
