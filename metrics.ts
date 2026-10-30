import type { Context, EventRow } from './sdk-types';

export type Usage = { inputTokens: number; outputTokens: number; cachedInputTokens: number };
type TurnRecord = { root: boolean | null; usage: Usage | null };
type TextItem = { count: number; complete: boolean; started: boolean; tail: string };
export type Turn = {
  id: string; start: number; end: number | null; closed: boolean; model: string | null;
  checkpointId: string | null; recoveredOutput: number | null;
  baseline: number | null; output: number | null; badCounter: boolean; textComplete: boolean;
  items: Map<string, TextItem>;
};
export type Metrics = {
  threadId: string; seq: number; session: string | null; usage: Usage | null;
  usageTurnId: string | null; turns: Map<string, TurnRecord>;
  context: Context; turn: Turn | null; pendingModel: string | null; seenIds: Set<string>; requests: Map<string, string>;
};
export const initialMetrics = (threadId: string): Metrics => ({ threadId, seq: -1, session: null, usage: null, usageTurnId: null, turns: new Map(), context: null, turn: null, pendingModel: null, seenIds: new Set(), requests: new Map() });
const nonnegative = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const counter = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
/** Validate JSON counters at the SDK boundary; retain only fields used by our formulas. */
export function parseUsage(value: unknown): Usage | null {
  if (value == null || typeof value !== 'object') return null;
  const u = value as Partial<Usage>;
  if (!counter(u.inputTokens) || !counter(u.outputTokens) || !counter(u.cachedInputTokens) || u.cachedInputTokens > u.inputTokens || !Number.isSafeInteger(u.inputTokens + u.outputTokens)) return null;
  return { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cachedInputTokens: u.cachedInputTokens };
}
const equalUsage = (a: Usage | null, b: Usage | null) => a != null && b != null && a.inputTokens === b.inputTokens && a.outputTokens === b.outputTokens && a.cachedInputTokens === b.cachedInputTokens;
const regresses = (a: Usage, b: Usage) => b.inputTokens < a.inputTokens || b.outputTokens < a.outputTokens || b.cachedInputTokens < a.cachedInputTokens;
function rememberTurn(s: Metrics, id: string, record: TurnRecord) {
  s.turns.set(id, record);
  if (s.turns.size > 2000) s.turns.delete(s.turns.keys().next().value!);
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
  const s: Metrics = { ...previous, seenIds: new Set(previous.seenIds), requests: new Map(previous.requests), turns: new Map(previous.turns), turn: previous.turn && { ...previous.turn, items: new Map(previous.turn.items) } };
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
    if ('providerThreadId' in d && d.providerThreadId) {
      if (s.session === null) s.session = d.providerThreadId;
      if (d.providerThreadId !== s.session) continue;
    }
    if (e.type === 'thread/context/cleared' || e.type === 'thread/compacted') {
      if (!s.turn || turnId === null || turnId === s.turn.id) clear(s);
      continue;
    }
    if (e.type === 'turn/started' && turnId) {
      rememberTurn(s, turnId, { root: !e.data.parentToolCallId, usage: null });
      if (e.data.parentToolCallId) continue;
      // A session snapshot alone cannot prove that its turn was a root turn.
      const baseline = s.usage && s.usageTurnId && s.usageTurnId !== turnId && s.turns.get(s.usageTurnId)?.root === true && (!s.turn || (s.usageTurnId === s.turn.id && !s.turn.badCounter)) ? s.usage.outputTokens : null;
      s.turn = { id: turnId, start: e.createdAt, end: null, closed: false, model: s.pendingModel,
        checkpointId: null, recoveredOutput: null, baseline, output: null, badCounter: false, textComplete: true, items: new Map() };
      s.pendingModel = null;
      continue;
    }
    const t = s.turn;
    if (t && turnId === t.id && e.type === 'turn/completed') {
      const checkpoint = e.data.providerCheckpointId ?? null;
      if (t.checkpointId !== checkpoint) t.recoveredOutput = null;
      t.checkpointId = checkpoint;
    }
    const owns = t != null && turnId === t.id;
    if (e.type === 'thread/contextWindowUsage/updated' && (turnId === null || owns)) {
      const c = e.data.contextWindowUsage;
      s.context = c.usedTokens != null && c.modelContextWindow != null ? validContext({ ...c, usedTokens: c.usedTokens, modelContextWindow: c.modelContextWindow }) : null;
    }
    if (e.type === 'system/thread/interrupted' && t && !t.closed) { t.end = e.createdAt; t.closed = true; }
    if (e.type === 'thread/tokenUsage/updated' && turnId) {
      const record = s.turns.get(turnId);
      if (!e.data.providerThreadId || record?.root === false) continue;
      const u = parseUsage(e.data.tokenUsage?.total);
      // A repeated prior-turn snapshot is not a new measurement of the current session.
      if (!owns && equalUsage(record?.usage ?? null, u)) continue;
      if (t) {
        if (!owns) t.badCounter = true; // late changed counters make its pre-turn baseline ambiguous
        else {
          if (!u || (s.usage && regresses(s.usage, u)) || (record?.usage && regresses(record.usage, u))) t.badCounter = true;
          t.output = u?.outputTokens ?? null;
        }
      }
      rememberTurn(s, turnId, { root: record?.root ?? null, usage: u });
      s.usage = u;
      s.usageTurnId = turnId;
      continue;
    }
    if (!t || !owns) continue;
    // Terminal time stays frozen, but authoritative complete text may arrive later.
    if (t.closed && e.type !== 'item/completed') continue;
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
  const seconds = t && end != null && Number.isFinite(t.start) && end >= t.start ? (end - t.start) / 1000 : null;
  const elapsed = seconds != null && Number.isFinite(seconds) ? seconds : null;
  let numerator: number | null = null;
  if (t && provider === 'codex' && !t.badCounter && t.baseline != null && t.output != null && t.output >= t.baseline) numerator = t.output - t.baseline;
  if (t?.closed && provider === 'codex' && numerator === null && t.recoveredOutput != null) numerator = t.recoveredOutput;
  if (t && provider === 'acp-cursor' && t.textComplete && [...t.items.values()].every(i => i.complete || i.started)) {
    numerator = [...t.items.values()].reduce((n, i) => n + i.count + (i.tail ? 1 : 0), 0);
  }
  const speed = elapsed != null && elapsed > 0 && numerator != null ? numerator / elapsed : null;
  return { elapsed, speed: speed != null && Number.isFinite(speed) ? speed : null,
    total: s.usage ? s.usage.inputTokens + s.usage.outputTokens : null,
    cache: s.usage && s.usage.inputTokens > 0 ? s.usage.cachedInputTokens / s.usage.inputTokens * 100 : null,
    context: validContext(s.context), model: t?.model ?? null };
}
