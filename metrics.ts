import type { Context, EventRow } from './sdk-types';

export type Usage = { inputTokens: number; outputTokens: number; cachedInputTokens: number };
type TextItem = { count: number; complete: boolean; started: boolean; tail: string };
export type Turn = {
  id: string; start: number; end: number | null; closed: boolean; model: string | null;
  baseline: number | null; output: number | null; badCounter: boolean; textComplete: boolean;
  items: Map<string, TextItem>;
};
export type Metrics = {
  threadId: string; seq: number; session: string | null; usage: Usage | null;
  context: Context; turn: Turn | null; pendingModel: string | null; seenIds: Set<string>; requests: Map<string, string>;
};
export const initialMetrics = (threadId: string): Metrics => ({ threadId, seq: -1, session: null, usage: null, context: null, turn: null, pendingModel: null, seenIds: new Set(), requests: new Map() });
const nonnegative = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
export function validUsage(u: Usage): boolean {
  return nonnegative(u.inputTokens) && nonnegative(u.outputTokens) && nonnegative(u.cachedInputTokens) && u.cachedInputTokens <= u.inputTokens && Number.isFinite(u.inputTokens + u.outputTokens);
}
export function validContext(c: Context): Context {
  return c && nonnegative(c.usedTokens) && nonnegative(c.modelContextWindow) && c.modelContextWindow > 0 ? c : null;
}
function clear(s: Metrics, session = s.session) {
  Object.assign(s, initialMetrics(s.threadId), { seq: s.seq, session, seenIds: s.seenIds });
}
// Streaming chunks can split surrogate pairs; retain only a trailing high surrogate.
function appendText(item: TextItem, delta: string): TextItem {
  let text = item.tail + delta;
  const tail = /[\uD800-\uDBFF]$/.test(text) ? text.slice(-1) : '';
  if (tail) text = text.slice(0, -1);
  return { ...item, count: item.count + Array.from(text).length, tail };
}
/** Deterministic reduction. Only accepted root turns establish metric ownership. */
export function reduceEvents(previous: Metrics, rows: readonly EventRow[]): Metrics {
  const s: Metrics = { ...previous, seenIds: new Set(previous.seenIds), requests: new Map(previous.requests), turn: previous.turn && { ...previous.turn, items: new Map(previous.turn.items) } };
  for (const e of [...rows].sort((a, b) => a.seq - b.seq)) {
    if (e.threadId !== s.threadId || !Number.isFinite(e.seq) || e.seq <= s.seq) continue;
    s.seq = e.seq;
    if (s.seenIds.has(e.id)) continue;
    s.seenIds.add(e.id);
    if (s.seenIds.size > 2000) s.seenIds.delete(s.seenIds.values().next().value!);
    const d = e.data;
    const turnId = e.scope.kind === 'turn' ? e.scope.turnId : null;
    if (e.type === 'thread/identity') {
      if (s.session !== e.data.providerThreadId) {
        const requests = s.requests;
        clear(s, e.data.providerThreadId);
        // Request ids are BB identities; acceptance can bind execution across session creation.
        s.requests = requests;
      }
      continue;
    }
    if (e.type === 'client/turn/requested') {
      s.requests.set(e.data.requestId, e.data.execution.model);
      if (s.requests.size > 32) s.requests.delete(s.requests.keys().next().value!);
      if (e.data.target.kind !== 'steer') s.pendingModel = e.data.execution.model ?? null;
      continue;
    }
    if ('providerThreadId' in d && d.providerThreadId != null) {
      if (s.session === null) s.session = d.providerThreadId;
      if (d.providerThreadId !== s.session) continue;
    }
    if (e.type === 'thread/context/cleared' || e.type === 'thread/compacted') {
      if (!s.turn || turnId === null || turnId === s.turn.id) clear(s);
      continue;
    }
    if (e.type === 'turn/started' && turnId && !e.data.parentToolCallId) {
      s.turn = { id: turnId, start: e.createdAt, end: null, closed: false, model: s.pendingModel,
        baseline: s.usage?.outputTokens ?? null, output: null, badCounter: false, textComplete: true, items: new Map() };
      s.pendingModel = null;
      continue;
    }
    const t = s.turn;
    const owns = t != null && turnId === t.id;
    if (e.type === 'thread/contextWindowUsage/updated' && (turnId === null || owns)) {
      const c = e.data.contextWindowUsage;
      s.context = c.usedTokens != null && c.modelContextWindow != null ? validContext({ ...c, usedTokens: c.usedTokens, modelContextWindow: c.modelContextWindow }) : null;
    }
    if (e.type === 'system/thread/interrupted' && t && !t.closed) { t.end = e.createdAt; t.closed = true; }
    if (!t || !owns) continue;
    if (e.type === 'thread/tokenUsage/updated') {
      const u = e.data.tokenUsage.total;
      if (!validUsage(u)) { s.usage = null; if (!t.closed) t.badCounter = true; continue; }
      if (!t.closed) {
        if (s.usage && (u.outputTokens < s.usage.outputTokens || u.inputTokens < s.usage.inputTokens || u.cachedInputTokens < s.usage.cachedInputTokens)) t.badCounter = true;
        t.output = u.outputTokens;
      }
      s.usage = u;
    }
    if (t.closed) continue;
    if (e.type === 'turn/input/accepted') t.model = s.requests.get(e.data.clientRequestId) ?? t.model;
    if (e.type === 'provider/modelFallback') t.model = e.data.fallbackModel;
    if (e.type === 'turn/completed' || (e.type === 'provider/error' && !e.data.willRetry) || e.type === 'system/error') {
      t.closed = true; t.end = e.createdAt;
    }
    if ((e.type === 'item/started' || e.type === 'item/completed') && e.data.item.type === 'agentMessage' && !e.data.item.parentToolCallId) {
      const item = e.data.item;
      if (!t.items.has(item.id) && t.items.size >= 2000) { t.textComplete = false; continue; }
      const old = t.items.get(item.id);
      // Completed snapshots survive BB's pruning of the corresponding deltas.
      t.items.set(item.id, e.type === 'item/completed'
        ? { count: Array.from(item.text).length, complete: true, started: true, tail: '' }
        : old ?? { count: 0, complete: false, started: true, tail: '' });
    }
    if (e.type === 'item/agentMessage/delta') {
      const id = e.data.itemId;
      if (e.data.parentToolCallId) continue;
      const item = t.items.get(id) ?? { count: 0, complete: false, started: false, tail: '' };
      if (item.complete) continue;
      if (!t.items.has(id) && t.items.size >= 2000) { t.textComplete = false; continue; }
      t.items.set(id, appendText(item, e.data.delta));
    }
  }
  return s;
}
export function metricView(s: Metrics, provider: string, active: boolean, now: number) {
  const t = s.turn;
  const end = t?.closed ? t.end : active ? now : null;
  const elapsed = t && end != null && Number.isFinite(t.start) && end >= t.start ? (end - t.start) / 1000 : null;
  let numerator: number | null = null;
  if (t && provider === 'codex' && !t.badCounter && t.baseline != null && t.output != null && t.output >= t.baseline) numerator = t.output - t.baseline;
  if (t && provider === 'acp-cursor' && t.textComplete && [...t.items.values()].every(i => i.complete || i.started)) {
    numerator = [...t.items.values()].reduce((n, i) => n + i.count + (i.tail ? 1 : 0), 0);
  }
  return { elapsed, speed: elapsed != null && elapsed > 0 && numerator != null ? numerator / elapsed : null,
    total: s.usage ? s.usage.inputTokens + s.usage.outputTokens : null,
    cache: s.usage && s.usage.inputTokens > 0 ? s.usage.cachedInputTokens / s.usage.inputTokens * 100 : null,
    context: validContext(s.context), model: t?.model ?? null };
}
