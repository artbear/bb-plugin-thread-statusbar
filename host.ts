import { experimental_defineHostEntry } from '@get-bb/plugin-sdk';
import { hostContract } from './recovery-contract';
import { readNativeOutput } from './native-output';
export default experimental_defineHostEntry({ contract: hostContract, handlers: {
  completedOutput: (input, context) => readNativeOutput(input, context.signal),
} });
