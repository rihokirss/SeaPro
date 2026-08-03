import type { Route, Track } from '@seapro/shared';

const DB_NAME = 'seapro-navigation';
const DB_VERSION = 1;

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('routes')) db.createObjectStore('routes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact<T>(storeName: 'routes' | 'tracks', mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return await new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

export const routeStore = {
  listRoutes: () => transact<Route[]>('routes', 'readonly', (store) => store.getAll()),
  saveRoute: (route: Route) => transact<IDBValidKey>('routes', 'readwrite', (store) => store.put(route)),
  deleteRoute: (id: string) => transact<undefined>('routes', 'readwrite', (store) => store.delete(id) as IDBRequest<undefined>),
  listTracks: () => transact<Track[]>('tracks', 'readonly', (store) => store.getAll()),
  saveTrack: (track: Track) => transact<IDBValidKey>('tracks', 'readwrite', (store) => store.put(track)),
};
