import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSdk, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { HISTORY_LIMIT, observeThread, type Observation } from '../observe-thread';
import type { EventRow, Sdk } from '../sdk-types';
import { event, start, usage } from './fixtures';
function fake(rows: EventRow[] = []) {
  let changed: (() => void) | undefined;
  let rewritten: (() => void) | undefined;
  let connection: ((state: 'connected' | 'disconnected') => void) | undefined;
  const unsubscribe = vi.fn();
  const get = vi.fn(async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, providerId: 'codex', status: 'active' }));
  const list = vi.fn(async (args: { beforeSeq?: string; afterSeq?: string; order?: string; limit?: string }) => {
    expect(args.limit).toBe('100');
    const filtered = rows.filter(e => (args.beforeSeq == null || e.seq < +args.beforeSeq) && (args.afterSeq == null || e.seq > +args.afterSeq));
    return (args.order === 'desc' ? [...filtered].reverse() : filtered).slice(0, 100);
  });
  const { sdk: base, harness } = createFakeSdk({ pluginId: 'thread-statusbar', overrides: { threads: { get, context: async () => ({ usage: null }), events: { list } } } });
  harness.stub('subscribe', (args: Parameters<Sdk['subscribe']>[0]) => {
    if (args.event === 'thread:changed') {
      const call = (changes: string[]) => args.callback({ entity: 'thread', id: 'A', changes } as never);
      changed = () => call(['events']); rewritten = () => call(['history-rewritten']);
    }
    if (args.event === 'realtime:connection') connection = state => args.callback({ state, reconnected: state === 'connected', reconnectDelayMs: null });
    return unsubscribe;
  });
  const sdk = base as unknown as Sdk;
  return { sdk, list, get, unsubscribe, changed: () => changed?.(), rewritten: () => rewritten?.(), connection: (s: 'connected' | 'disconnected') => connection?.(s) };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const settle = () => vi.advanceTimersByTimeAsync(0);
describe('bounded SDK observation', () => {
  it('paginates a suffix safely and increments by seq; coalesces a burst', async () => {
    const rows = Array.from({ length: 205 }, (_, i) => event(i + 1, 'provider/warning', { category: 'other' }));
    rows.push(start(206), usage(207, 100));
    const f = fake(rows), states: Observation[] = [];
    const stop = observeThread(f.sdk, 'A', s => states.push(s));
    await settle();
    expect(f.list).toHaveBeenCalledTimes(3);
    expect(states.at(-1)?.metrics.seq).toBe(207);
    for (let i = 0; i < 30; i++) f.changed();
    await vi.advanceTimersByTimeAsync(250);
    expect(f.list).toHaveBeenCalledTimes(4);
    expect(f.list.mock.calls.at(-1)?.[0].afterSeq).toBe('207');
    stop(); expect(f.unsubscribe).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds backfill and keeps missing starts unknown', async () => {
    const rows = Array.from({ length: HISTORY_LIMIT + 10 }, (_, i) => usage(i + 1, i + 1));
    const f = fake(rows), states: Observation[] = [];
    const stop = observeThread(f.sdk, 'A', s => states.push(s)); await settle();
    expect(f.list).toHaveBeenCalledTimes(20);
    expect(states.at(-1)).toMatchObject({ phase: 'ready', metrics: { turn: null, usage: null } });
    stop();
  });
  it('marks failed reads unavailable, rereads on reconnect and clears after rewrite', async () => {
    const rows = [start(1), usage(2, 160)];
    const f = fake(rows), states: Observation[] = [];
    const stop = observeThread(f.sdk, 'A', s => states.push(s)); await settle();
    f.list.mockRejectedValueOnce(new Error('offline'));
    f.changed(); await vi.advanceTimersByTimeAsync(250);
    expect(states.at(-1)?.phase).toBe('unavailable');
    f.connection('disconnected'); f.connection('connected'); await vi.advanceTimersByTimeAsync(250);
    expect(states.at(-1)?.phase).toBe('ready');
    expect(f.list.mock.calls.at(-1)?.[0].afterSeq).toBeUndefined();
    rows.splice(0); f.rewritten(); await vi.advanceTimersByTimeAsync(250);
    expect(states.at(-1)?.metrics.turn).toBeNull(); stop();
  });
  it('ignores late replies across A → B and disposes queries/subscriptions/timers', async () => {
    const f = fake(); let resolveA!: (rows: EventRow[]) => void;
    f.list.mockImplementationOnce(() => new Promise(resolve => { resolveA = resolve; }));
    const a: Observation[] = [], b: Observation[] = [];
    const stopA = observeThread(f.sdk, 'A', s => a.push(s)); await settle();
    stopA(); expect(vi.getTimerCount()).toBe(0); const count = a.length;
    const stopB = observeThread(f.sdk, 'B', s => b.push(s)); await settle();
    resolveA([start(1)]); await settle();
    expect(a).toHaveLength(count); expect(b.at(-1)?.metrics.threadId).toBe('B');
    stopB(); expect(vi.getTimerCount()).toBe(0); expect(f.unsubscribe).toHaveBeenCalledTimes(4);
  });
  it('does not overlap cycles and ignores the old generation after rewrite', async () => {
    const f = fake(); let resolve!: (rows: EventRow[]) => void;
    f.list.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const states: Observation[] = [];
    const stop = observeThread(f.sdk, 'A', s => states.push(s)); await settle();
    f.changed(); f.rewritten(); await vi.advanceTimersByTimeAsync(250);
    expect(f.list).toHaveBeenCalledTimes(1);
    resolve([start(1)]); await settle(); await vi.advanceTimersByTimeAsync(250);
    expect(states.at(-1)?.metrics.turn).toBeNull(); expect(f.list).toHaveBeenCalledTimes(2); stop();
  });
  it('rejects non-advancing pagination instead of looping forever', async () => {
    const f = fake(); f.list.mockImplementation(async () => Array.from({ length: 100 }, () => start(1)));
    const states: Observation[] = [];
    const stop = observeThread(f.sdk, 'A', s => states.push(s)); await settle();
    expect(states.at(-1)?.phase).toBe('unavailable'); expect(f.list).toHaveBeenCalledTimes(2); stop();
  });
});
it('clears provider-owned data before reading a replacement provider', async () => {
  const f = fake([start(1), usage(2, 160)]), states: Observation[] = [];
  const stop = observeThread(f.sdk, 'A', s => states.push(s)); await settle();
  f.get.mockResolvedValueOnce(makeThreadResponse({ id: 'A', providerId: 'acp-cursor', status: 'active' }));
  f.list.mockRejectedValueOnce(new Error('unavailable'));
  f.changed(); await vi.advanceTimersByTimeAsync(250);
  expect(states.at(-1)).toMatchObject({ phase: 'unavailable', thread: { providerId: 'acp-cursor' }, metrics: { turn: null, usage: null } });
  stop();
});
