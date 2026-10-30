import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const recovered = z.object({ sessionId: uuid, checkpointId: uuid, outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
export type Recovered = z.infer<typeof recovered>;
export const recoveryContract = defineRpcContract({ completedOutput: {
  input: z.object({ threadId: z.string().min(1).max(200), turnId: z.string().min(1).max(200) }).strict(),
  output: recovered.nullable(),
} });
export const hostContract = defineRpcContract({ completedOutput: {
  input: z.object({ sessionId: uuid, checkpointId: uuid, workspace: z.string().min(1).nullable() }).strict(),
  output: recovered.nullable(),
  experimental_retryable: true,
} });
