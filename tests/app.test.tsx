// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { experimental_scanPublicSdkOnly, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import type { ExperimentalThreadContextSegmentProps } from '@get-bb/plugin-sdk/app';
import { Summary } from '../app';
import { event, start } from './fixtures';
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
it.each(['codex', 'acp-cursor'])('renders readable %s metrics and keyboard-accessible native details', async providerId => {
  const stop = vi.fn();
  const slot = renderSlot({ component: Summary }, props, { sdk: { subscribe: () => stop, threads: {
    get: async () => makeThreadResponse({ id: 'A', providerId, status: 'idle' }), context: async () => ({ usage: { usedTokens: 0, modelContextWindow: 1000, estimated: true } }),
    events: { list: async () => [event(2, 'turn/completed', { status: 'completed' }, 'root', 3000), start(1)] },
  } } });
  await slot.findByText(providerId === 'codex' ? 'Codex' : 'Cursor');
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
