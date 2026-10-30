import type { Recovered } from './recovery-contract';
import { initialMetrics, reduceEvents, validContext, type Metrics } from './metrics';
import { EVENT_TYPES, type EventRow, type Sdk, type Thread } from './sdk-types';
export type Observation = { phase: 'loading' | 'ready' | 'unavailable'; thread: Thread | null; metrics: Metrics };
export const supports = (id: string) => id === 'codex' || id === 'acp-cursor';
export const HISTORY_LIMIT = 2000;
/** One read cycle at a time; invalidations are hints, never event payloads. */
export function observeThread(sdk: Sdk, threadId: string, publish: (s: Observation) => void, recover?: (input: { threadId: string; turnId: string }) => Promise<Recovered | null>) {
  let state: Observation = { phase: 'loading', thread: null, metrics: initialMetrics(threadId) };
  let stopped = false, busy = false, dirty = false, full = true, epoch = 0, online = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempted: string | null = null;
  let recovered: Recovered | null = null;
  let controller: AbortController | undefined;
  let readTimeout: ReturnType<typeof setTimeout> | undefined;
  const emit = () => { if (!stopped) publish(state); };
  const unavailable = () => { state = { ...state, phase: 'unavailable' }; emit(); };
  function schedule(reset = false) {
    if (reset) { epoch++; full = true; attempted = null; recovered = null; controller?.abort(); }
    dirty = true;
    if (!stopped && online && !busy && timer === undefined) timer = setTimeout(() => { timer = undefined; void read(); }, 250);
  }
  async function pages(signal: AbortSignal, replay: boolean, after: number): Promise<EventRow[]> {
    const rows: EventRow[] = [];
    let cursor = replay ? undefined : after;
    for (let p = 0; p < HISTORY_LIMIT / 100; p++) {
      const page = await sdk.threads.events.list({ threadId, types: EVENT_TYPES, order: replay ? 'desc' : 'asc', limit: '100', signal,
        ...(cursor === undefined ? {} : replay ? { beforeSeq: String(cursor) } : { afterSeq: String(cursor) }) });
      if (page.some(e => e.threadId !== threadId || !Number.isFinite(e.seq))) throw new Error('Invalid event scope');
      const unique = page.filter(e => cursor === undefined || (replay ? e.seq < cursor : e.seq > cursor));
      if (page.length && !unique.length) throw new Error('Event cursor did not advance');
      rows.push(...unique);
      if (page.length < 100) return rows;
      cursor = replay ? Math.min(...unique.map(e => e.seq)) : Math.max(...unique.map(e => e.seq));
    }
    // A bounded suffix is safe for replay: missing starts/baselines remain unknown.
    // Incremental overflow must resync rather than show a partial current view.
    if (!replay) throw new Error('Incremental history limit');
    return rows;
  }
  async function read() {
    if (stopped || busy || !online) return;
    busy = true; dirty = false;
    const version = epoch, replay = full;
    const abort = new AbortController(); controller = abort;
    const timeout = setTimeout(() => abort.abort(), 15000); readTimeout = timeout;
    try {
      const thread = await sdk.threads.get({ threadId, signal: abort.signal });
      if (thread.id !== threadId) throw new Error('Wrong thread');
      if (stopped || version !== epoch || abort.signal.aborted) return;
      const providerChanged = state.thread != null && thread.providerId !== state.thread.providerId;
      if (!state.thread || providerChanged) { state = { phase: 'loading', thread, metrics: initialMetrics(threadId) }; emit(); }
      if (providerChanged) { attempted = null; recovered = null; }
      const reset = replay || providerChanged;
      const rows = supports(thread.providerId) ? await pages(abort.signal, reset, state.metrics.seq) : [];
      // Read context after history, so a concurrently recorded clear cannot restore an older measurement.
      const context = supports(thread.providerId) ? await sdk.threads.context({ threadId, signal: abort.signal }) : { usage: null };
      if (stopped || version !== epoch || abort.signal.aborted) return;
      const metrics = reduceEvents(reset ? initialMetrics(threadId) : state.metrics, rows);
      // context() is authoritative, including a null measurement after a clear.
      metrics.context = context.usage?.snapshot && metrics.session !== context.usage.snapshot.providerSessionId ? null : validContext(context.usage);
      const turn = metrics.turn;
      const key = turn?.closed && turn.checkpointId && metrics.session ? JSON.stringify([threadId, metrics.session, turn.id, turn.checkpointId]) : null;
      if (key && key === attempted && recovered && turn) turn.recoveredOutput = recovered.outputTokens;
      state = { phase: 'ready', thread, metrics }; full = false; emit();
      if (key !== attempted) {
        attempted = key; recovered = null;
        if (recover && key && turn && thread.providerId === 'codex' && (turn.badCounter || turn.baseline === null || turn.output === null)) {
          // A missing native file affects only speed. Epoch/abort keep late data out of a reset.
          let result: Recovered | null = null;
          let cancel: (() => void) | undefined;
          const cancelled = new Promise<null>(resolve => { cancel = () => resolve(null); abort.signal.addEventListener('abort', cancel, { once: true }); });
          try { result = await Promise.race([recover({ threadId, turnId: turn.id }), cancelled]); } catch { /* unavailable native evidence */ }
          finally { if (cancel) abort.signal.removeEventListener('abort', cancel); }
          if (stopped || version !== epoch || abort.signal.aborted || dirty) { attempted = null; recovered = null; return; }
          if (result && result.sessionId === metrics.session && result.checkpointId === turn.checkpointId && Number.isSafeInteger(result.outputTokens) && result.outputTokens >= 0) {
            recovered = result;
            state = { ...state, metrics: { ...metrics, turn: { ...turn, recoveredOutput: result.outputTokens } } };
            emit();
          }
        }
      }
    } catch {
      if (!stopped && version === epoch) { full = true; unavailable(); }
    } finally {
      clearTimeout(timeout); if (readTimeout === timeout) readTimeout = undefined; busy = false;
      if (controller === abort) controller = undefined;
      if (dirty) schedule();
    }
  }
  const unsubThread = sdk.subscribe({ event: 'thread:changed', threadId, callback(event) {
    const reset = event.changes.some(c => c === 'history-rewritten' || c === 'history-compacted');
    schedule(reset);
  } });
  const unsubConnection = sdk.subscribe({ event: 'realtime:connection', callback(event) {
    online = event.state === 'connected';
    if (!online) { epoch++; full = true; attempted = null; recovered = null; controller?.abort(); unavailable(); }
    else schedule(true);
  } });
  emit(); void read();
  return () => { stopped = true; epoch++; controller?.abort(); clearTimeout(timer); clearTimeout(readTimeout); unsubThread(); unsubConnection(); };
}
