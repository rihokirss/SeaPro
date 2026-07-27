import { useCallback, useEffect, useState } from 'react';

export interface Favorite {
  id: string;
  name: string;
  lat: number;
  lon: number;
  createdAt: number;
}

const STORAGE_KEY = 'seapro.favorites';
const SCHEMA_VERSION = 1;

interface Stored {
  version: number;
  items: Favorite[];
}

function load(): Favorite[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Stored;
    // Versioon on siin selleks, et hilisem serveripoolne sünkroniseerimine
    // saaks vanad kirjed ära tunda ja migreerida, mitte vaikselt kaotada.
    if (parsed.version !== SCHEMA_VERSION || !Array.isArray(parsed.items)) return [];
    return parsed.items;
  } catch {
    return [];
  }
}

function save(items: Favorite[]): void {
  const payload: Stored = { version: SCHEMA_VERSION, items };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

/** Ümardatud koordinaadid ID-ks — sama koht ei satu topelt nimekirja. */
function keyFor(lat: number, lon: number): string {
  return `${lat.toFixed(3)},${lon.toFixed(3)}`;
}

export function useFavorites() {
  const [items, setItems] = useState<Favorite[]>(load);

  useEffect(() => {
    save(items);
  }, [items]);

  const add = useCallback((name: string, lat: number, lon: number) => {
    setItems((prev) => {
      const id = keyFor(lat, lon);
      if (prev.some((f) => f.id === id)) return prev;
      return [...prev, { id, name, lat, lon, createdAt: Date.now() }];
    });
  }, []);

  const remove = useCallback((id: string) => {
    setItems((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const isFavorite = useCallback(
    (lat: number, lon: number) => items.some((f) => f.id === keyFor(lat, lon)),
    [items],
  );

  const rename = useCallback((id: string, name: string) => {
    setItems((prev) => prev.map((f) => (f.id === id ? { ...f, name } : f)));
  }, []);

  return { items, add, remove, rename, isFavorite, keyFor };
}
