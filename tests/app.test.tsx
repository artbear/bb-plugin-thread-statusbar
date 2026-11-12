// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { experimental_scanPublicSdkOnly, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import type { ExperimentalThreadContextSegmentProps } from '@get-bb/plugin-sdk/app';
import { Summary } from '../app';
import { event, start } from './fixtures';
import type { EventRow } from '../sdk-types';
const props: ExperimentalThreadContextSegmentProps = { threadId: 'A', projectId: 'P', environment: null, segments: [], isExpanded: false, onToggle: vi.fn() };
afterEach(() => vi.restoreAllMocks());
it('registers only the native context slot and filters providers', async () => {
  const app = await loadPluginApp(() => import('../app'));
  expect(app.threadContextSegments).toHaveLength(1);
  expect(app.navPanels).toHaveLength(0);
  const segment = app.threadContextSegments[0]!;
  expect(segment.details).toBeDefined();
  const Visible = () => <span>{String(segment.useVisible!(props))}</span>;
  const slot = renderSlot({ component: Visible }, {}, { sdk: { threads: { get: async () => makeThreadResponse({ id: 'A', providerId: 'other' }) }, subscribe: () => () => {} } });
  await act(async () => { await Promise.resolve(); });
  await slot.findByText('false'); slot.lifecycle.unmount();
});
it.each(['codex', 'acp-cursor', 'acp-hermes-agent'])('renders readable %s metrics and keyboard-accessible native details', async providerId => {
  const stop = vi.fn();
  const slot = renderSlot({ component: Summary }, props, { sdk: { subscribe: () => stop, threads: {
    get: async () => makeThreadResponse({ id: 'A', providerId, status: 'idle' }), context: async () => ({ usage: { usedTokens: 0, modelContextWindow: 1000, estimated: true } }),
    events: { list: async () => [event(2, 'turn/completed', { status: 'completed' }, 'root', 3000), start(1)] },
  } } });
  await slot.findByText(providerId === 'codex' ? 'Codex' : providerId === 'acp-cursor' ? 'Cursor' : 'Hermes');
  await slot.findByText('00:02');
  expect(slot.container.querySelector('[data-thread-statusbar="A"] [data-metric="context"]')?.textContent).toContain('≈0/1');
  fireEvent.click(slot.getByRole('button'));
  expect(props.onToggle).toHaveBeenCalled();
  act(() => slot.lifecycle.unmount()); expect(stop).toHaveBeenCalledTimes(2);
});
it('uses public SDK imports only', () => {
  const scan = experimental_scanPublicSdkOnly(process.cwd(), { allow: [/^react(?:\/.*)?$/, /^vitest(?:\/.*)?$/, /^@testing-library\/react$/] });
  expect(scan.violations).toEqual([]); expect(scan.privateDependencies).toEqual([]);
});
it('survives StrictMode resubscription without leaking or restarting on every render', async () => {
  const { StrictMode } = await import('react');
  const get = vi.fn(async () => makeThreadResponse({ id: 'A', providerId: 'codex', status: 'idle' }));
  const unsubscribe = vi.fn();
  const Wrapped = () => <StrictMode><Summary {...props} /></StrictMode>;
  const slot = renderSlot({ component: Wrapped }, {}, { sdk: { subscribe: () => unsubscribe, threads: {
    get, context: async () => ({ usage: null }), events: { list: async () => [] },
  } } });
  await slot.findByText('Готов');
  expect(get.mock.calls.length).toBeLessThanOrEqual(2);
  slot.lifecycle.unmount();
  expect(unsubscribe.mock.calls.length).toBe(get.mock.calls.length * 2);
});
it('shares one observer between native visibility and summary', async () => {
  const app = await loadPluginApp(() => import('../app'));
  const segment = app.threadContextSegments[0]!;
  const subscriptions = vi.fn(() => () => {});
  const get = vi.fn(async () => makeThreadResponse({ id: 'A', providerId: 'acp-cursor', status: 'idle' }));
  const NativeSegment = () => segment.useVisible!(props) ? <Summary {...props} /> : null;
  const slot = renderSlot({ component: NativeSegment }, {}, { sdk: { subscribe: subscriptions, threads: {
    get, context: async () => ({ usage: null }), events: { list: async () => [] },
  } } });
  await slot.findByText('Готов');
  expect(get).toHaveBeenCalledTimes(1); expect(subscriptions).toHaveBeenCalledTimes(2);
  slot.lifecycle.unmount();
});
it('cold open and remount render recovered full-turn average with frozen BB duration', async () => {
  const sessionId = '019d2210-0000-7000-8000-000000000001', checkpointId = '019d2210-0000-7000-8000-000000000002';
  for (let attempt = 0; attempt < 2; attempt++) {
    const rows = [start(1), event(2, 'thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 900 } } }), event(3, 'turn/completed', { providerCheckpointId: checkpointId }, 'root', 11000)].map(e => ({ ...e, data: { ...e.data, providerThreadId: sessionId } } as EventRow));
    const rpc = vi.fn(async () => ({ sessionId, checkpointId, outputTokens: 240 }));
    const slot = renderSlot({ component: Summary }, props, { rpc: { completedOutput: rpc }, sdk: { subscribe: () => () => {}, threads: {
      get: async () => makeThreadResponse({ id: 'A', providerId: 'codex', status: 'idle' }), context: async () => ({ usage: null }), events: { list: async () => [...rows].reverse() },
    } } });
    await slot.findByText('сред. 24 ток/с');
    expect(slot.getByText('00:10')).toBeDefined();
    expect(slot.getByText('Всего 1 900 ток')).toBeDefined();
    expect(rpc).toHaveBeenCalledTimes(1);
    slot.lifecycle.unmount();
  }
});

it('shows Hermes in the native slot and retains reasoning and fast for the current turn', async () => {
  const app = await loadPluginApp(() => import('../app'));
  const segment = app.threadContextSegments[0]!;
  const NativeSegment = () => segment.useVisible!(props) ? <Summary {...props} /> : null;
  const rows = [
    event(1, 'client/turn/requested', { requestId: 'r1', target: { kind: 'new-turn' }, execution: { model: 'model-A', reasoningLevel: 'high', serviceTier: 'fast' } }, null),
    start(2), event(3, 'turn/input/accepted', { clientRequestId: 'r1' }),
    event(4, 'provider/modelFallback', { fallbackModel: 'model-B' }),
    event(5, 'client/turn/requested', { requestId: 'r2', target: { kind: 'new-turn' }, execution: { model: 'next', reasoningLevel: 'low', serviceTier: 'default' } }, null),
    event(6, 'item/completed', { item: { id: 'm', type: 'agentMessage', text: 'А🙂Б' } }),
    event(7, 'turn/completed', {}, 'root', 4000),
  ];
  const rpc = vi.fn(async () => null);
  const slot = renderSlot({ component: NativeSegment }, {}, { rpc: { completedOutput: rpc }, sdk: { subscribe: () => () => {}, threads: {
    get: async () => makeThreadResponse({ id: 'A', providerId: 'acp-hermes-agent', status: 'idle' }), context: async () => ({ usage: null }), events: { list: async () => [...rows].reverse() },
  } } });
  await slot.findByText('Hermes');
  await slot.findByText('model-B');
  expect(slot.getByText('high')).toBeDefined();
  expect(slot.getByText('fast')).toBeDefined();
  expect(slot.getByText('сред. — ток/с')).toBeDefined();
  expect(slot.queryByText('default')).toBeNull();
  expect(slot.queryByText(/симв\/с/)).toBeNull();
  expect(rpc).not.toHaveBeenCalled();
  slot.lifecycle.unmount();
});
it.each(['default', 'fast'])('renders service tier %s and recorded reasoning', async serviceTier => {
  const rows = [event(1, 'client/turn/requested', { requestId: 'r', target: { kind: 'new-turn' }, execution: { model: 'm', reasoningLevel: 'medium', serviceTier } }, null), start(2)];
  const slot = renderSlot({ component: Summary }, props, { sdk: { subscribe: () => () => {}, threads: {
    get: async () => makeThreadResponse({ id: 'A', providerId: 'acp-cursor', status: 'idle' }), context: async () => ({ usage: null }), events: { list: async () => [...rows].reverse() },
  } } });
  await slot.findByText('medium');
  expect(slot.queryByText('default')).toBeNull();
  expect(slot.queryByText('fast') != null).toBe(serviceTier === 'fast');
  slot.lifecycle.unmount();
});
