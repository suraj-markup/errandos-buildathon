import type { Capability } from '@errandos/contracts';
export interface WorkerStatus { readonly status: 'idle'; readonly providerOperations: Capability }
export function getWorkerStatus(): WorkerStatus { return { status: 'idle', providerOperations: { status: 'unavailable', reason: 'out-of-scope' } }; }

if (process.argv[1]?.endsWith('index.js')) console.log(JSON.stringify(getWorkerStatus()));