import { loadVoiceRuntimePolicy } from '../lib/runtime-policy';
import {
  createLiveRealtimeShadowEvaluator,
  createLiveResponsesShadowEvaluator,
} from '../lib/realtime/live-shadow-evaluators';
import { runRealtimeShadowEvaluationV1 } from '../lib/realtime/shadow-runtime';

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is required.');

  const policy = loadVoiceRuntimePolicy();
  const runStamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const result = await runRealtimeShadowEvaluationV1({
    realtime: {
      evaluator: createLiveRealtimeShadowEvaluator({
        apiKey,
        model: policy.realtime.model,
      }),
      model: policy.realtime.model,
      runId: `realtime-${runStamp}`,
    },
    responses: {
      evaluator: createLiveResponsesShadowEvaluator({
        apiKey,
        model: policy.boundedControlModel,
      }),
      model: policy.boundedControlModel,
      runId: `responses-${runStamp}`,
    },
    timeoutMs: 30_000,
    version: 1,
  });

  process.stdout.write(result.json);
}

void main();
