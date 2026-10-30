import type { EventRow } from '../sdk-types';
// Fixtures exercise the public wire shape; extra required request fields are irrelevant here.
export function event(seq: number, type: EventRow['type'], data: object = {}, turn: string | null = 'root', time = seq * 1000): EventRow {
  return { id: `e${seq}`, threadId: 'A', seq, createdAt: time,
    scope: turn == null ? { kind: 'thread' } : { kind: 'turn', turnId: turn }, type,
    data: { providerThreadId: 'session', ...data } } as EventRow;
}
export const start = (seq: number, turn = 'root', time = seq * 1000) => event(seq, 'turn/started', {}, turn, time);
export function usage(seq: number, output: number, turn = 'root', input = 1000, cached = 400) {
  const total = { inputTokens: input, outputTokens: output, cachedInputTokens: cached, reasoningOutputTokens: 99, totalTokens: 999999 };
  return event(seq, 'thread/tokenUsage/updated', { tokenUsage: { total, last: total, modelContextWindow: null } }, turn);
}
