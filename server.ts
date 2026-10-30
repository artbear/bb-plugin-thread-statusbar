import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { recoveryContract, hostContract, uuid } from './recovery-contract';
import { initialMetrics, reduceEvents } from './metrics';
import { EVENT_TYPES, type EventRow } from './sdk-types';
export default function threadStatusbar(bb: BbPluginApi): void {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const running = new Set<AbortController>();
  bb.onDispose(() => { for (const controller of running) controller.abort(); running.clear(); });
  bb.rpc.register(recoveryContract, { async completedOutput({ threadId, turnId }) {
    const controller = new AbortController();
    running.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const thread = await bb.sdk.threads.get({ threadId, include: 'environment,host', signal: controller.signal });
      if (thread.id !== threadId || thread.providerId !== 'codex' || !('environment' in thread) || !thread.environment?.hostId) return null;
      if ('host' in thread && thread.host && thread.host.id !== thread.environment.hostId) return null;
      const rows: EventRow[] = [];
      let cursor: number | undefined;
      for (let p = 0; p < 20; p++) {
        const page = await bb.sdk.threads.events.list({ threadId, types: EVENT_TYPES, signal: controller.signal, order: 'desc', limit: '100', ...(cursor === undefined ? {} : { beforeSeq: String(cursor) }) });
        if (page.some(e => e.threadId !== threadId || !Number.isSafeInteger(e.seq) || (cursor !== undefined && e.seq >= cursor))) return null;
        rows.push(...page);
        if (page.length < 100) break;
        cursor = Math.min(...page.map(e => e.seq));
      }
      const metrics = reduceEvents(initialMetrics(threadId), rows);
      const turn = metrics.turn;
      if (!turn?.closed || turn.id !== turnId || !uuid.safeParse(metrics.session).success || !uuid.safeParse(turn.checkpointId).success) return null;
      const result = await host.call('completedOutput', { sessionId: metrics.session!, checkpointId: turn.checkpointId!, workspace: thread.environment.path }, { hostId: thread.environment.hostId, signal: controller.signal, timeoutMs: 10000 });
      return result?.sessionId === metrics.session && result.checkpointId === turn.checkpointId ? result : null;
    } catch { return null; } finally { clearTimeout(timeout); running.delete(controller); }
  } });
}
