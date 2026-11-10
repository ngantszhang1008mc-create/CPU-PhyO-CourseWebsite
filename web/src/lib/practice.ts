// Each setting has its own key so saving one problem never overwrites another.
import { useSyncExternalStore } from 'react';
const prefix = 'cpu-phyo:v1:';
const fallback = new Map<string, string>();
const listeners = new Set<() => void>();

function changed() {
  for (const notify of listeners) notify();
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  window.addEventListener('storage', notify);
  window.addEventListener('pageshow', notify);
  return () => {
    listeners.delete(notify);
    window.removeEventListener('storage', notify);
    window.removeEventListener('pageshow', notify);
  };
}

function read(key: string) {
  if (fallback.has(key)) return fallback.get(key);
  try {
    return window.localStorage.getItem(prefix + key);
  } catch {
    return null;
  }
}

export function save(key: string, value: string) {
  try {
    window.localStorage.setItem(prefix + key, value);
    fallback.delete(key);
  } catch {
    fallback.set(key, value);
  }
  changed();
}

export function useValue<T extends string>(key: string, allowed: readonly T[], initial: T): T {
  return useSyncExternalStore(
    subscribe,
    () => {
      const value = read(key);
      return allowed.find((option) => option === value) ?? initial;
    },
    () => initial,
  );
}

export function useCompleted(ids: string[]) {
  return useSyncExternalStore(
    subscribe,
    () => ids.filter((id) => read(id + ':done') === 'yes').length,
    () => 0,
  );
}

export function useMode() {
  return useValue('mode', ['guide', 'quiz'] as const, 'guide');
}
