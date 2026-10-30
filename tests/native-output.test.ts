import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOutput, readNativeOutput, MAX_BYTES } from '../native-output';
import hostEntry from '../host';
import { experimental_createHostEntryHarness } from '@get-bb/plugin-sdk/testing/host';
const sessionId = '019d2210-0000-7000-8000-000000000001';
const checkpointId = '019d2210-0000-7000-8000-000000000002';
const identity = { sessionId, checkpointId };
const meta = { type: 'session_meta', payload: { id: sessionId } };
const record = (output: unknown) => ({ type: 'token_usage_record', payload: { thread_id: sessionId, session_id: sessionId, turn_id: checkpointId, root_turn_id: checkpointId, usage: { output_tokens: 7 }, turn_token_usage: { output_tokens: output }, thread_token_usage: { output_tokens: 9999 } } });
const terminal = { type: 'event_msg', payload: { type: 'task_complete', turn_id: checkpointId } };
const trace = () => [meta, record(40), record(240), terminal];
async function* lines(rows: unknown[]) { for (const row of rows) yield typeof row === 'string' ? row : JSON.stringify(row); }
const parse = (rows: unknown[], signal = new AbortController().signal) => parseOutput(lines(rows), identity, signal);
it('takes the last aggregate, with no summing snapshots, reasoning or last-response fallback', async () => {
  expect(await parse(trace())).toEqual({ ...identity, outputTokens: 240 });
});
it.each(['thread_id', 'session_id', 'root_turn_id', 'turn_id'] as const)('rejects a target record with wrong %s', async key => {
  const bad = record(240); bad.payload[key] = '019d2210-0000-7000-8000-000000000009';
  expect(await parse([meta, bad, terminal])).toBeNull();
});
it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, '240'])('rejects invalid output %s', async value => {
  expect(await parse([meta, record(value), terminal])).toBeNull();
});
it('requires exact metadata, terminal and nonregressing snapshots; rejects malformed input', async () => {
  for (const rows of [[record(240), terminal], [meta, record(240)], [meta, record(240), { ...terminal, payload: { ...terminal.payload, turn_id: 'other' } }], [meta, record(240), record(40), terminal], [meta, record(40), terminal, record(240)], [meta, '{'], [{ ...meta, payload: { id: 'other' } }, record(240), terminal]]) expect(await parse(rows)).toBeNull();
});
it('honors cancellation during parsing', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(parse(trace(), controller.signal)).rejects.toThrow();
});
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function store(location = 'sessions') {
  const root = await mkdtemp(join(tmpdir(), 'statusbar-test-')); roots.push(root);
  const date = new Date(parseInt(sessionId.replaceAll('-', '').slice(0, 12), 16)).toISOString().slice(0, 10).replaceAll('-', '/');
  const dir = location === 'sessions' ? join(root, location, date) : join(root, location);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-example-${sessionId}.jsonl`);
  await writeFile(path, trace().map(row => JSON.stringify(row)).join('\n') + '\n');
  return { root, dir, path };
}
it.each(['sessions', 'archived_sessions'])('locates exact file in %s without reading other sessions', async location => {
  const { root, dir } = await store(location);
  await writeFile(join(dir, 'rollout-other.jsonl'), 'not JSON');
  expect(await readNativeOutput({ ...identity, workspace: null }, new AbortController().signal, root)).toEqual({ ...identity, outputTokens: 240 });
});
it('handles adjacent date folders, relative home and rejects ambiguity, symlinks, partial and oversized files', async () => {
  const { root, path } = await store('archived_sessions');
  const signal = new AbortController().signal;
  const input = { ...identity, workspace: root };
  expect(await readNativeOutput(input, signal, '.')).toEqual({ ...identity, outputTokens: 240 });
  expect(await readNativeOutput({ ...input, workspace: null }, signal, '.')).toBeNull();
  const date = new Date(parseInt(sessionId.replaceAll('-', '').slice(0, 12), 16) + 86400000).toISOString().slice(0, 10).replaceAll('-', '/');
  const adjacent = join(root, 'sessions', date); await mkdir(adjacent, { recursive: true });
  const duplicate = join(adjacent, `rollout-adjacent-${sessionId}.jsonl`);
  await writeFile(duplicate, trace().map(row => JSON.stringify(row)).join('\n') + '\n');
  expect(await readNativeOutput(input, signal, root)).toBeNull();
  await rm(path);
  expect(await readNativeOutput(input, signal, root)).toEqual({ ...identity, outputTokens: 240 });
  await rm(duplicate); await symlink('/etc/passwd', duplicate);
  expect(await readNativeOutput(input, signal, root)).toBeNull();
  await rm(duplicate); await writeFile(duplicate, JSON.stringify(meta));
  expect(await readNativeOutput(input, signal, root)).toBeNull();
  await writeFile(duplicate, 'x'.repeat(MAX_BYTES + 1));
  expect(await readNativeOutput(input, signal, root)).toBeNull();
});
it('host contract validates identity, keeps errors private and disposes resources', async () => {
  const { root } = await store();
  vi.stubEnv('CODEX_HOME', root);
  const harness = experimental_createHostEntryHarness(hostEntry);
  await expect(harness.experimental_call('completedOutput', { sessionId: 'bad', checkpointId, workspace: null })).rejects.toThrow();
  expect(await harness.experimental_call('completedOutput', { ...identity, workspace: null })).toEqual({ ...identity, outputTokens: 240 });
  await harness.experimental_dispose();
});

it('rejects file ownership mismatch and a symlinked store root', async () => {
  const { root } = await store();
  const link = root + '-link'; roots.push(link); await symlink(root, link);
  expect(await readNativeOutput({ ...identity, workspace: null }, new AbortController().signal, link)).toBeNull();
  if (process.getuid) {
    const uid = process.getuid(); vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    expect(await readNativeOutput({ ...identity, workspace: null }, new AbortController().signal, root)).toBeNull();
  }
});
it('rejects missing record IDs and a reopened unfinished checkpoint', async () => {
  expect(await parse([meta, record(40), { type: 'token_usage_record', payload: {} }, terminal])).toBeNull();
  expect(await parse([...trace(), { type: 'event_msg', payload: { type: 'task_started', turn_id: checkpointId } }])).toBeNull();
  expect(await parse([meta, record(0), terminal])).toEqual({ ...identity, outputTokens: 0 });
});
