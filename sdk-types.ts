import type { useSdk } from '@get-bb/plugin-sdk/app';
export type Sdk = ReturnType<typeof useSdk>;
export type EventRow = Awaited<ReturnType<Sdk['threads']['events']['list']>>[number];
export type Thread = Awaited<ReturnType<Sdk['threads']['get']>>;
export type Context = Awaited<ReturnType<Sdk['threads']['context']>>['usage'];
export const EVENT_TYPES = ['client/turn/requested', 'turn/input/accepted', 'turn/started', 'turn/completed', 'thread/identity', 'thread/context/cleared', 'thread/compacted', 'thread/tokenUsage/updated', 'thread/contextWindowUsage/updated', 'item/started', 'item/completed', 'item/agentMessage/delta', 'system/thread/interrupted', 'provider/modelFallback', 'provider/error', 'system/error'] as const;
