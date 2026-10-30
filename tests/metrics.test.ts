import { describe, expect, it } from 'vitest';
import { initialMetrics, metricView, reduceEvents, validContext } from '../metrics';
import { event, start, usage } from './fixtures';
const view = (rows: ReturnType<typeof event>[], provider = 'codex', active = false, now = 900000) => metricView(reduceEvents(initialMetrics('A'), rows), provider, active, now);
const baseline = [start(1, 'prior'), usage(2, 100, 'prior'), event(3, 'turn/completed', { status: 'completed' }, 'prior')];
describe('official counters and full turn time', () => {
  it('uses cumulative output difference, never reasoning/last/duplicate sum; freezes completion', () => {
    const rows = [...baseline, start(4, 'root', 10000), usage(5, 130), usage(6, 160), usage(6, 160), event(7, 'turn/completed', { status: 'completed' }, 'root', 20000)];
    expect(view(rows)).toMatchObject({ elapsed: 10, speed: 6, total: 1160, cache: 40 });
    const state = reduceEvents(initialMetrics('A'), rows);
    expect(reduceEvents(state, rows)).toEqual(state);
    expect(metricView(state, 'codex', true, 999999).speed).toBe(6);
  });
  it('does not invent a first-turn baseline, and resets on next turn, identity and clear', () => {
    expect(view([start(1), usage(2, 160)], 'codex', true, 3000).speed).toBeNull();
    const rows = [...baseline, start(4), usage(5, 160), start(6, 'next')];
    expect(view(rows, 'codex', true, 10000).speed).toBeNull();
    for (const reset of [event(7, 'thread/identity', { providerThreadId: 'new' }, null), event(7, 'thread/context/cleared', {}, 'next')]) {
      expect(view([...rows, reset])).toMatchObject({ elapsed: null, speed: null, total: null, model: null });
    }
  });
  it('invalidates reset/inconsistent counters and keeps real zeros', () => {
    expect(view([...baseline, start(4), usage(5, 50), usage(6, 180)], 'codex', true, 10000).speed).toBeNull();
    expect(view([start(1), usage(2, 200, 'root', 1000, 0)])).toMatchObject({ total: 1200, cache: 0 });
    expect(view([start(1), usage(2, 0, 'root', 0, 0)]).cache).toBeNull();
    for (const bad of [-1, NaN, Infinity, 1001]) expect(view([start(1), usage(2, 200, 'root', 1000, bad)]).total).toBeNull();
  });
  it.each(['turn/completed', 'provider/error', 'system/thread/interrupted'] as const)('freezes %s, unknown ending does not run the clock', type => {
    const rows = [start(1), event(2, type, { status: 'interrupted' })];
    expect(view(rows, 'codex', true, 50000).elapsed).toBe(1);
    expect(view([start(1)], 'codex', false).elapsed).toBeNull();
    expect(view([start(1), event(2, 'turn/completed', { status: 'completed' }, 'root', 1000)]).speed).toBeNull();
  });
});
describe('Cursor visible text', () => {
  const textStart = event(2, 'item/started', { item: { type: 'agentMessage', id: 'm', text: '' } });
  const deltas = [event(3, 'item/agentMessage/delta', { itemId: 'm', delta: 'А🙂' }), event(4, 'item/agentMessage/delta', { itemId: 'm', delta: 'Б' })];
  const done = event(6, 'turn/completed', { status: 'completed' }, 'root', 3000);
  it('reconciles Unicode deltas and final snapshots, including pruned replay', () => {
    const snapshot = event(5, 'item/completed', { item: { type: 'agentMessage', id: 'm', text: 'А🙂Б' } });
    expect(view([start(1), textStart, ...deltas, snapshot, done], 'acp-cursor').speed).toBe(1.5);
    expect(view([start(1), snapshot, done], 'acp-cursor').speed).toBe(1.5);
    const split = [event(3, 'item/agentMessage/delta', { itemId: 'm', delta: 'А\uD83D' }), event(4, 'item/agentMessage/delta', { itemId: 'm', delta: '\uDE42Б' })];
    expect(view([start(1), textStart, ...split, done], 'acp-cursor').speed).toBe(1.5);
  });
  it('excludes child turns, reasoning, tool output, background items and alien threads', () => {
    const extra = [event(3, 'turn/started', { parentToolCallId: 'tool' }, 'child'), event(4, 'item/agentMessage/delta', { itemId: 'x', delta: 'bad' }, 'child'), event(5, 'item/reasoning/textDelta', { itemId: 'r', delta: 'bad' }), event(6, 'item/commandExecution/outputDelta', { itemId: 't', delta: 'bad' }), event(7, 'item/agentMessage/delta', { itemId: 'n', delta: 'bad', parentToolCallId: 'tool' }), { ...usage(8, 999), threadId: 'B' }];
    expect(view([start(1), textStart, ...extra, event(9, 'turn/completed', { status: 'completed' }, 'root', 3000)], 'acp-cursor').speed).toBe(0);
  });
  it('does not present incomplete text/history as a measurement', () => {
    expect(view(deltas, 'acp-cursor').speed).toBeNull();
    expect(view([start(1), ...deltas, done], 'acp-cursor').speed).toBeNull();
    expect(view([start(1), done], 'acp-cursor').speed).toBe(0);
  });
});
it('keeps context independent, nullable, estimated and zero-aware', () => {
  const s = reduceEvents(initialMetrics('A'), [start(1), usage(2, 200), event(3, 'thread/contextWindowUsage/updated', { contextWindowUsage: { usedTokens: 300, modelContextWindow: 1000, estimated: true } })]);
  expect(metricView(s, 'codex', true, 5000).context).toMatchObject({ usedTokens: 300, modelContextWindow: 1000, estimated: true });
  expect(validContext({ usedTokens: 0, modelContextWindow: 1000, estimated: false })?.usedTokens).toBe(0);
  expect(validContext({ usedTokens: 1, modelContextWindow: 0, estimated: true })).toBeNull();
  expect(validContext(null)).toBeNull();
});
it('records execution model and fallback without renaming for the next request', () => {
  const rows = [event(1, 'client/turn/requested', { requestId: 'r1', target: { kind: 'new-turn' }, execution: { model: 'model-A' } }, null), start(2), event(3, 'provider/modelFallback', { fallbackModel: 'model-B' }), event(4, 'client/turn/requested', { requestId: 'r2', target: { kind: 'new-turn' }, execution: { model: 'model-C' } }, null)];
  expect(view(rows).model).toBe('model-B');
});

it('deduplicates ids even across pages and excludes nested token/context resets', () => {
  const a = event(5, 'item/agentMessage/delta', { itemId: 'm', delta: 'A' });
  const s = reduceEvents(initialMetrics('A'), [start(1), event(2, 'item/started', { item: { type: 'agentMessage', id: 'm', text: '' } }), a, { ...a, seq: 6 }, event(7, 'thread/context/cleared', {}, 'nested'), usage(8, 999, 'nested'), event(9, 'turn/completed', { status: 'completed' }, 'root', 3000)]);
  expect(metricView(s, 'acp-cursor', false, 90000)).toMatchObject({ speed: 0.5, total: null });
});

it('binds recorded execution by accepted request across creation of a provider session', () => {
  const rows = [event(1, 'client/turn/requested', { requestId: 'r1', target: { kind: 'thread-start' }, execution: { model: 'actual' } }, null), event(2, 'thread/identity', {}, null), start(3), event(4, 'turn/input/accepted', { clientRequestId: 'r1' })];
  expect(view(rows).model).toBe('actual');
});
