import { expect, it, vi } from 'vitest';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from '../server';
import { event, start, usage } from './fixtures';
const sessionId = '019d2210-0000-7000-8000-000000000001';
const checkpointId = '019d2210-0000-7000-8000-000000000002';
const rows = () => [start(1), usage(2, 900), event(3, 'turn/completed', { providerCheckpointId: checkpointId }, 'root', 11000)].map(e => ({ ...e, data: { ...e.data, providerThreadId: sessionId } }));
async function setup(providerId = 'codex', environment: object | null = { hostId: 'host-execution', path: '/example/workspace' }) {
  const callHost = vi.fn(async () => ({ sessionId, checkpointId, outputTokens: 240 }));
  const get = vi.fn(async () => ({ ...makeThreadResponse({ id: 'A', providerId }), environment }));
  const list = vi.fn(async () => rows());
  const { bb, harness } = createFakePluginHost({ pluginId: 'thread-statusbar', experimental_hostEntry: true, experimental_callHostRpc: callHost,
    sdk: { threads: { get, events: { list } } } });
  plugin(bb);
  return { harness, callHost, get, list };
}
it('resolves native identity and execution host server-side, with load-safe factory', async () => {
  const f = await setup();
  expect(f.callHost).not.toHaveBeenCalled();
  expect(await f.harness.behavior.callRpc('completedOutput', { threadId: 'A', turnId: 'root' })).toEqual({ sessionId, checkpointId, outputTokens: 240 });
  expect(f.get).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'A', include: 'environment,host' }));
  expect(f.callHost).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'host-execution', method: 'completedOutput', input: { sessionId, checkpointId, workspace: '/example/workspace' } }));
  await f.harness.lifecycle.dispose();
});
it('rejects client paths, hosts and sessions at the RPC boundary', async () => {
  const f = await setup();
  for (const field of ['path', 'hostId', 'sessionId']) await expect(f.harness.behavior.callRpc('completedOutput', { threadId: 'A', turnId: 'root', [field]: 'untrusted' })).rejects.toThrow();
  expect(f.callHost).not.toHaveBeenCalled(); await f.harness.lifecycle.dispose();
});
it.each(['acp-cursor', 'other'])('never recovers %s or defaults an unknown host to server', async provider => {
  const f = await setup(provider);
  expect(await f.harness.behavior.callRpc('completedOutput', { threadId: 'A', turnId: 'root' })).toBeNull();
  expect(f.callHost).not.toHaveBeenCalled(); await f.harness.lifecycle.dispose();
  const unknown = await setup('codex', null);
  expect(await unknown.harness.behavior.callRpc('completedOutput', { threadId: 'A', turnId: 'root' })).toBeNull();
  expect(unknown.callHost).not.toHaveBeenCalled(); await unknown.harness.lifecycle.dispose();
});
it('requires matching closed root, current session and native checkpoint', async () => {
  const f = await setup();
  for (const invalid of [rows().slice(0, 2), rows().map(e => e.type === 'turn/started' ? { ...e, data: { ...e.data, parentToolCallId: 'tool' } } : e), rows().map(e => e.type === 'turn/completed' ? { ...e, data: { ...e.data, providerCheckpointId: undefined } } : e)]) {
    f.list.mockResolvedValueOnce(invalid);
    expect(await f.harness.behavior.callRpc('completedOutput', { threadId: 'A', turnId: 'root' })).toBeNull();
  }
  expect(await f.harness.behavior.callRpc('completedOutput', { threadId: 'A', turnId: 'other' })).toBeNull();
  expect(f.callHost).not.toHaveBeenCalled(); await f.harness.lifecycle.dispose();
});
