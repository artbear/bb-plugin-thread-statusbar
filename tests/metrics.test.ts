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
  const s = reduceEvents(initialMetrics('A'), [start(1), event(2, 'item/started', { item: { type: 'agentMessage', id: 'm', text: '' } }), event(3, 'turn/started', { parentToolCallId: 'tool' }, 'nested'), a, { ...a, seq: 6 }, event(7, 'thread/context/cleared', {}, 'nested'), usage(8, 999, 'nested'), event(9, 'turn/completed', { status: 'completed' }, 'root', 3000)]);
  expect(metricView(s, 'acp-cursor', false, 90000)).toMatchObject({ speed: 0.5, total: null });
});

it('binds recorded execution by accepted request across creation of a provider session', () => {
  const rows = [event(1, 'client/turn/requested', { requestId: 'r1', target: { kind: 'thread-start' }, execution: { model: 'actual' } }, null), event(2, 'thread/identity', {}, null), start(3), event(4, 'turn/input/accepted', { clientRequestId: 'r1' })];
  expect(view(rows).model).toBe('actual');
});

describe('review regressions: terminal snapshots and session accounting', () => {
  const complete = (seq: number) => event(seq, 'turn/completed', { status: 'completed' }, 'root', 20000);
  it('accepts late own usage with or without an intermediate snapshot, freezing duration', () => {
    for (const middle of [[], [usage(5, 130)]]) {
      const state = reduceEvents(initialMetrics('A'), [...baseline, start(4, 'root', 10000), ...middle, complete(6)]);
      const refined = reduceEvents(state, [usage(7, 160)]);
      expect(metricView(refined, 'codex', true, 999999)).toMatchObject({ elapsed: 10, speed: 6, total: 1160, cache: 40 });
      expect(reduceEvents(refined, [usage(7, 160)])).toEqual(refined);
      expect(metricView(state, 'codex', true, 999999).speed).toBe(middle.length ? 3 : null);
    }
  });
  it.each([-1, 150, 1e308, 160.5])('invalidates late invalid/regressing output %s after completion', output => {
    const state = reduceEvents(initialMetrics('A'), [...baseline, start(4, 'root', 10000), usage(5, 160), complete(6), usage(7, output)]);
    expect(metricView(state, 'codex', true, 999999)).toMatchObject({ elapsed: 10, speed: null });
    if (output !== 150) expect(state.usage).toBeNull();
  });
  it('invalidates ambiguous baseline on changed prior counters without using foreign output', () => {
    const before = reduceEvents(initialMetrics('A'), [...baseline, start(4, 'root', 10000)]);
    const late = reduceEvents(before, [usage(5, 160, 'prior')]);
    expect(late.turn?.output).toBeNull();
    expect(metricView(late, 'codex', true, 15000)).toMatchObject({ speed: null, total: 1160 });
    const final = reduceEvents(late, [usage(6, 220), complete(7)]);
    expect(metricView(final, 'codex', false, 999999)).toMatchObject({ elapsed: 10, speed: null, total: 1220 });
  });
  it('ignores unchanged late prior snapshots and excludes known nested/foreign sessions', () => {
    const rows = [...baseline, start(4, 'root', 10000), usage(5, 160), usage(6, 100, 'prior'),
      event(7, 'turn/started', { parentToolCallId: 'tool' }, 'child'), usage(8, 999, 'child'),
      event(9, 'thread/tokenUsage/updated', { ...usage(9, 888).data, providerThreadId: 'foreign' }), complete(10)];
    expect(view(rows)).toMatchObject({ elapsed: 10, speed: 6, total: 1160 });
  });
  it('keeps session totals/cache without a start but does not invent a root baseline', () => {
    expect(view([usage(1, 200)])).toMatchObject({ elapsed: null, speed: null, total: 1200, cache: 40 });
    for (const turn of ['root', 'pruned']) expect(view([usage(1, 200, turn), start(2), usage(3, 260)], 'codex', true, 12000).speed).toBeNull();
    expect(view([event(1, 'thread/identity', {}, null), usage(2, 200)])).toMatchObject({ total: 1200, cache: 40, elapsed: null });
  });
  it('keeps snapshot-only totals scoped to the observed thread/session', () => {
    const rows = [event(1, 'thread/identity', {}, null), usage(2, 200),
      event(3, 'thread/tokenUsage/updated', { ...usage(3, 999).data, providerThreadId: 'foreign' }),
      { ...usage(4, 888), threadId: 'B' }];
    expect(view(rows)).toMatchObject({ total: 1200, cache: 40, speed: null });
    expect(view([event(1, 'turn/started', { parentToolCallId: 'tool' }, 'child'), usage(2, 999, 'child')]).total).toBeNull();
  });
  it('reconciles a late completed Cursor snapshot at the frozen terminal time', () => {
    const before = reduceEvents(initialMetrics('A'), [start(1), event(2, 'item/started', { item: { type: 'agentMessage', id: 'm', text: '' } }), event(3, 'turn/completed', { status: 'completed' }, 'root', 3000)]);
    const snapshot = event(4, 'item/completed', { item: { type: 'agentMessage', id: 'm', text: 'А🙂Б' } });
    const after = reduceEvents(before, [snapshot, { ...snapshot, id: 'duplicate', seq: 5 }]);
    expect(metricView(after, 'acp-cursor', true, 999999)).toMatchObject({ elapsed: 2, speed: 1.5 });
    expect(metricView(before, 'acp-cursor', true, 999999).speed).toBe(0);
  });
  it('rejects unsafe/non-integer JSON counters and never emits nonfinite derived values', () => {
    for (const output of [1e308, Number.MAX_SAFE_INTEGER + 1, 1.5]) {
      expect(view([start(1, 'prior'), usage(2, 0, 'prior'), start(3, 'root', 10000), usage(4, output), event(5, 'turn/completed', {}, 'root', 10001)])).toMatchObject({ speed: null, total: null });
    }
    const rows = [start(1, 'prior'), usage(2, 0, 'prior'), start(3, 'root', 0), usage(4, 200), event(5, 'turn/completed', {}, 'root', 1e-310)];
    expect(view(rows).speed).toBeNull();
    expect(Object.values(view(rows)).filter(v => typeof v === 'number').every(Number.isFinite)).toBe(true);
    expect(view([usage(1, Number.MAX_SAFE_INTEGER, 'root', 1, 0)]).total).toBeNull();
  });
});

it('does not reuse a late regressing counter as next-turn baseline, then recovers from a fresh own snapshot', () => {
  const invalid = reduceEvents(initialMetrics('A'), [...baseline, start(4, 'root', 10000), usage(5, 160),
    event(6, 'turn/completed', { status: 'completed' }, 'root', 20000), usage(7, 150)]);
  const next = reduceEvents(invalid, [start(8, 'next', 30000), usage(9, 200, 'next'),
    event(10, 'turn/completed', { status: 'completed' }, 'next', 40000)]);
  expect(next.turn?.baseline).toBeNull();
  expect(metricView(next, 'codex', false, 999999)).toMatchObject({ elapsed: 10, speed: null, total: 1200 });
  const recovered = reduceEvents(next, [start(11, 'recovered', 50000), usage(12, 260, 'recovered'),
    event(13, 'turn/completed', { status: 'completed' }, 'recovered', 60000)]);
  expect(recovered.turn?.baseline).toBe(200);
  expect(metricView(recovered, 'codex', false, 999999)).toMatchObject({ elapsed: 10, speed: 6, total: 1260 });
  expect(invalid.turn?.badCounter).toBe(true);
});

it.each(['codex', 'acp-cursor', 'acp-hermes-agent'])('uses official output and token units for %s', provider => {
  const rows = [...baseline, start(4, 'root', 10000), usage(5, 160), event(6, 'item/completed', { item: { type: 'agentMessage', id: 'm', text: 'unrelated text' } }), event(7, 'turn/completed', {}, 'root', 20000)];
  expect(view(rows, provider)).toMatchObject({ speed: 6, speedUnit: 'ток/с', total: 1160, cache: 40 });
});
it('never estimates Hermes output from visible characters without usage or baseline', () => {
  const rows = [start(1), event(2, 'item/completed', { item: { type: 'agentMessage', id: 'm', text: 'А🙂Б' } }), event(4, 'turn/completed', {}, 'root', 3000)];
  expect(view(rows, 'acp-hermes-agent')).toMatchObject({ speed: null, speedUnit: 'ток/с' });
  expect(view([start(1), usage(2, 160), event(3, 'turn/completed', {}, 'root', 3000)], 'acp-hermes-agent').speed).toBeNull();
  expect(view(rows, 'acp-cursor')).toMatchObject({ speed: 1.5, speedUnit: 'симв/с' });
});
it('counts the first Cursor snapshot as turn speed and leaves Codex and Hermes unchanged', () => {
  const rows = [start(1), usage(2, 160), event(3, 'turn/completed', {}, 'root', 3000)];
  expect(view(rows, 'acp-cursor')).toMatchObject({ elapsed: 2, speed: 80, speedUnit: 'ток/с', total: 1160 });
  expect(view(rows, 'codex').speed).toBeNull();
  expect(view(rows, 'acp-hermes-agent').speed).toBeNull();
  const total = { inputTokens: 1000, outputTokens: 160, cachedInputTokens: 400, reasoningOutputTokens: 0, totalTokens: 1160 };
  const last = { ...total, outputTokens: 20, totalTokens: 1020 };
  const partial = event(2, 'thread/tokenUsage/updated', { tokenUsage: { total, last, modelContextWindow: null } });
  expect(view([start(1), partial, event(3, 'turn/completed', {}, 'root', 3000)], 'acp-cursor')).toMatchObject({ speed: null, speedUnit: 'ток/с' });
});
function hermesUsage(seq: number, output: number, lastOutput: number, turn = 'root', time = seq * 1000) {
  const total = { inputTokens: 1000, outputTokens: output, cachedInputTokens: 400, reasoningOutputTokens: 0, totalTokens: 1000 + output };
  const last = { inputTokens: 10, outputTokens: lastOutput, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 10 + lastOutput };
  return event(seq, 'thread/tokenUsage/updated', { tokenUsage: { total, last, modelContextWindow: null } }, turn, time);
}
it('counts Hermes speed from last when resume omits the baseline snapshot', () => {
  const rows = [...baseline, start(4, 'silent', 10000), event(5, 'turn/completed', {}, 'silent', 20000), start(6, 'next', 30000), hermesUsage(7, 160, 20, 'next', 30000), event(8, 'turn/completed', {}, 'next', 40000)];
  expect(view(rows, 'acp-hermes-agent')).toMatchObject({ elapsed: 10, speed: 2, total: 1160 });
  const again = [...rows, start(9, 'later', 50000), hermesUsage(10, 180, 20, 'later', 50000), event(11, 'turn/completed', {}, 'later', 60000)];
  expect(view(again, 'acp-hermes-agent')).toMatchObject({ elapsed: 10, speed: 2, total: 1180 });
});
it('keeps Hermes speed when a new process lowers the session total', () => {
  const rows = [...baseline, start(4, 'next', 10000), hermesUsage(5, 50, 20, 'next', 10000), event(6, 'turn/completed', {}, 'next', 20000)];
  expect(view(rows, 'acp-hermes-agent')).toMatchObject({ elapsed: 10, speed: 2, total: 1050 });
  expect(view(rows, 'codex').speed).toBeNull();
  const next = [...rows, start(7, 'after', 30000), hermesUsage(8, 70, 20, 'after', 30000), event(9, 'turn/completed', {}, 'after', 40000)];
  expect(view(next, 'acp-hermes-agent')).toMatchObject({ elapsed: 10, speed: 2, total: 1070 });
});
it('binds reasoning and service tier to accepted execution, while fallback replaces only the model', () => {
  const rows = [
    event(1, 'client/turn/requested', { requestId: 'r1', target: { kind: 'thread-start' }, execution: { model: 'A', reasoningLevel: 'high', serviceTier: 'fast' } }, null),
    event(2, 'thread/identity', {}, null), start(3), event(4, 'turn/input/accepted', { clientRequestId: 'r1' }),
    event(5, 'provider/modelFallback', { fallbackModel: 'B' }),
    event(6, 'client/turn/requested', { requestId: 'r2', target: { kind: 'new-turn' }, execution: { model: 'C', reasoningLevel: 'low', serviceTier: 'default' } }, null),
  ];
  expect(view(rows)).toMatchObject({ model: 'B', reasoningLevel: 'high', serviceTier: 'fast' });
  expect(view([...rows, event(7, 'turn/completed'), start(8, 'next'), event(9, 'turn/input/accepted', { clientRequestId: 'r2' }, 'next')])).toMatchObject({ model: 'C', reasoningLevel: 'low', serviceTier: 'default' });
});
