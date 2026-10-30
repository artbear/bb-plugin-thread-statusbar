import { useCallback, useSyncExternalStore } from 'react';
import { useSdk } from '@get-bb/plugin-sdk/app';
import { initialMetrics } from './metrics';
import { observeThread, type Observation } from './observe-thread';
import type { Sdk } from './sdk-types';
type Store = { state: Observation; listeners: Set<() => void>; stop?: () => void };
const stores = new WeakMap<Sdk, Map<string, Store>>();
export function useThreadStatus(threadId: string): Observation {
  const sdk = useSdk();
  let byThread = stores.get(sdk);
  if (!byThread) { byThread = new Map(); stores.set(sdk, byThread); }
  let store = byThread.get(threadId);
  if (!store) {
    store = { state: { phase: 'loading', thread: null, metrics: initialMetrics(threadId) }, listeners: new Set() };
    byThread.set(threadId, store);
  }
  const current = store;
  const subscribe = useCallback((listener: () => void) => {
    current.listeners.add(listener);
    if (!current.stop) current.stop = observeThread(sdk, threadId, state => { current.state = state; for (const notify of current.listeners) notify(); });
    return () => {
      current.listeners.delete(listener);
      if (!current.listeners.size) { current.stop?.(); current.stop = undefined; queueMicrotask(() => {
        const entries = stores.get(sdk);
        if (!current.listeners.size && entries?.get(threadId) === current) entries.delete(threadId);
      }); }
    };
  }, [sdk, threadId, current]);
  return useSyncExternalStore(subscribe, () => current.state);
}
