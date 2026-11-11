export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
export type ThemeSnapshot = Readonly<{ preference: ThemePreference; resolved: ResolvedTheme; saving: boolean; failed: boolean }>;
export const themeStorageKey = 'rivloom.ui.theme';

export function normalizeTheme(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}
export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === 'system' ? systemDark ? 'dark' : 'light' : preference;
}

/** Only a successful durable write changes the selected preference. System changes
 * remain live while a write is pending, and never replace the saved `system` choice. */
export function createThemeState(options: {
  preference: ThemePreference; systemDark: boolean;
  save: (preference: ThemePreference) => Promise<void>;
  apply: (resolved: ResolvedTheme, preference: ThemePreference) => void;
}) {
  let dark = options.systemDark;
  let snapshot: ThemeSnapshot = Object.freeze({ preference: options.preference, resolved: resolveTheme(options.preference, dark), saving: false, failed: false });
  const listeners = new Set<() => void>();
  const publish = (next: ThemeSnapshot) => {
    snapshot = Object.freeze(next);
    options.apply(next.resolved, next.preference);
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    systemChanged(next: boolean) {
      dark = next;
      const resolved = resolveTheme(snapshot.preference, dark);
      if (resolved !== snapshot.resolved) publish({ ...snapshot, resolved });
    },
    async select(preference: ThemePreference) {
      if (!['light', 'dark', 'system'].includes(preference)) throw new Error('Invalid theme');
      if (snapshot.saving || (preference === snapshot.preference && !snapshot.failed)) return;
      publish({ ...snapshot, saving: true, failed: false });
      try {
        await options.save(preference);
        publish({ preference, resolved: resolveTheme(preference, dark), saving: false, failed: false });
      } catch {
        publish({ ...snapshot, saving: false, failed: true });
      }
    },
  };
}

let appearanceRevision = 0;
function applyTheme(resolved: ResolvedTheme, preference: ThemePreference) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (root.dataset.theme && root.dataset.theme !== resolved) {
    // Controls previously used different color transition durations: white text
    // could arrive before its dark surface. Switch the palette atomically while
    // preserving the DOM, layout, focus and ongoing activity animations.
    const revision = ++appearanceRevision;
    root.dataset.themeSwitching = '';
    void root.offsetWidth;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (revision === appearanceRevision) delete root.dataset.themeSwitching;
    }));
  }
  root.dataset.theme = resolved;
  root.dataset.themePreference = preference;
  root.style.colorScheme = resolved;
  root.style.backgroundColor = resolved === 'dark' ? '#1e2025' : '#ffffff';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#1e2025' : '#ffffff');
  const sessionKey = (window as Window & { __RIVLOOM_THEME_SESSION__?: string }).__RIVLOOM_THEME_SESSION__;
  if (sessionKey) { try { sessionStorage.setItem(sessionKey, preference); } catch { /* Native preference remains authoritative on restart. */ } }
}

let state = createThemeState({ preference: 'system', systemDark: false, save: async () => {}, apply: applyTheme });
export const themeSnapshot = () => state.getSnapshot();
export const subscribeTheme = (listener: () => void) => state.subscribe(listener);
export const selectTheme = (value: ThemePreference) => state.select(value);

export async function initializeTheme() {
  const { invoke, isTauri } = await import('@tauri-apps/api/core');
  const native = isTauri();
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = normalizeTheme(document.documentElement.dataset.themePreference);
  if (native) {
    try { preference = normalizeTheme((await invoke<{ theme?: string }>('desktop_info')).theme); }
    catch { /* Keep the native initialization-script preference if startup fails. */ }
  } else {
    try { preference = normalizeTheme(localStorage.getItem(themeStorageKey)); } catch { /* System remains usable when storage is disabled. */ }
  }
  state = createThemeState({ preference, systemDark: media.matches, apply: applyTheme,
    save: async next => {
      if (native) await invoke('set_desktop_theme', { theme: next });
      else localStorage.setItem(themeStorageKey, next);
    },
  });
  applyTheme(state.getSnapshot().resolved, preference);
  media.addEventListener('change', event => state.systemChanged(event.matches));
}
