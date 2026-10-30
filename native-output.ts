import { constants } from 'node:fs';
import { open, opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { Recovered } from './recovery-contract';
import { uuid } from './recovery-contract';
export const MAX_BYTES = 32 * 1024 * 1024;
const MAX_LINE = 2 * 1024 * 1024;
type Identity = { sessionId: string; checkpointId: string };
/** Only official cumulative root-turn output; no response or session-total inference. */
export async function parseOutput(lines: AsyncIterable<string>, identity: Identity, signal: AbortSignal): Promise<Recovered | null> {
  let metadata = false, terminal = false, output: number | null = null;
  let bytes = 0;
  for await (const line of lines) {
    signal.throwIfAborted();
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > MAX_BYTES || Buffer.byteLength(line) > MAX_LINE) return null;
    let row;
    try { row = JSON.parse(line); } catch { return null; }
    if (!row || typeof row !== 'object') return null;
    const p = row.payload;
    if (row.type === 'session_meta') {
      if (metadata || p?.id !== identity.sessionId) return null;
      metadata = true;
    }
    if (row.type === 'token_usage_record' && (!metadata || p?.thread_id !== identity.sessionId || p?.session_id !== identity.sessionId || !uuid.safeParse(p?.turn_id).success || !uuid.safeParse(p?.root_turn_id).success)) return null;
    if (row.type === 'event_msg' && p?.turn_id === identity.checkpointId && p.type === 'task_started' && (terminal || output !== null)) return null;
    if (row.type === 'token_usage_record' && (p?.turn_id === identity.checkpointId || p?.root_turn_id === identity.checkpointId)) {
      if (!metadata || terminal || p.thread_id !== identity.sessionId || p.session_id !== identity.sessionId || p.turn_id !== identity.checkpointId || p.root_turn_id !== identity.checkpointId) return null;
      const next = p.turn_token_usage?.output_tokens;
      if (!Number.isSafeInteger(next) || next < 0 || (output !== null && next < output)) return null;
      output = next;
    }
    if (row.type === 'event_msg' && p?.turn_id === identity.checkpointId && (p.type === 'task_complete' || p.type === 'turn_aborted')) {
      if (!metadata || output === null || terminal) return null;
      terminal = true;
    }
  }
  return metadata && terminal && output !== null ? { sessionId: identity.sessionId, checkpointId: identity.checkpointId, outputTokens: output } : null;
}
async function* boundedLines(file: Awaited<ReturnType<typeof open>>, signal: AbortSignal, snapshotBytes: number) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunk = Buffer.alloc(64 * 1024);
  let tail = '', total = 0;
  for (;;) {
    signal.throwIfAborted();
    if (total === snapshotBytes) break;
    const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, snapshotBytes - total), total);
    if (!bytesRead) throw new Error('truncated');
    total += bytesRead;
    if (total > MAX_BYTES) throw new Error('limit');
    tail += decoder.decode(chunk.subarray(0, bytesRead), { stream: true });
    let end;
    while ((end = tail.indexOf('\n')) >= 0) {
      const line = tail.slice(0, end); tail = tail.slice(end + 1);
      if (Buffer.byteLength(line) > MAX_LINE) throw new Error('limit');
      yield line;
    }
    if (Buffer.byteLength(tail) > MAX_LINE) throw new Error('limit');
  }
  // Only newline-terminated records belong to this snapshot. An unfinished suffix
  // cannot prove completion or reopening; the parser still requires target terminal.

}
/** Date is a bounded locator only. Metadata and every target record prove ownership. */
export async function readNativeOutput(input: Identity & { workspace: string | null }, signal: AbortSignal, codexHome = process.env.CODEX_HOME): Promise<Recovered | null> {
  try {
    if (!uuid.safeParse(input.sessionId).success || !uuid.safeParse(input.checkpointId).success || input.sessionId[14] !== '7') return null;
    const configured = codexHome?.trim();
    if (configured && !isAbsolute(configured) && (!input.workspace || !isAbsolute(input.workspace))) return null;
    const store = configured ? resolve(input.workspace ?? '/', configured) : join(homedir(), '.codex');
    if (await realpath(store) !== store) return null;
    const timestamp = parseInt(input.sessionId.replaceAll('-', '').slice(0, 12), 16);
    const directories = [join(store, 'archived_sessions')];
    for (const offset of [-1, 0, 1]) {
      const date = new Date(timestamp + offset * 86400000).toISOString().slice(0, 10).replaceAll('-', '/');
      directories.push(join(store, 'sessions', date), join(store, 'archived_sessions', date));
    }
    const matches: string[] = [];
    for (const directory of directories) {
      signal.throwIfAborted();
      let dir;
      try {
        if (await realpath(directory) !== directory) return null;
        dir = await opendir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      let count = 0;
      for await (const entry of dir) {
        signal.throwIfAborted();
        if (++count > 10000) return null;
        if (entry.name.startsWith('rollout-') && entry.name.endsWith(`-${input.sessionId}.jsonl`)) {
          if (!entry.isFile() || entry.isSymbolicLink()) return null;
          matches.push(join(directory, entry.name));
        }
      }
    }
    if (matches.length !== 1) return null;
    const path = matches[0];
    if (await realpath(path) !== path) return null;
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > MAX_BYTES || (process.getuid && before.uid !== process.getuid())) return null;
      const result = await parseOutput(boundedLines(file, signal, before.size), input, signal);
      const after = await file.stat();
      signal.throwIfAborted();
      // Native rollouts append records. Growth after the captured boundary does not
      // change the completed target; truncation or an in-place rewrite is rejected.
      return after.size >= before.size && (after.size > before.size || before.mtimeMs === after.mtimeMs) ? result : null;
    } finally { await file.close(); }
  } catch { return null; }
}
