import { loadVoiceRuntimePolicy } from '../lib/runtime-policy';
import { OpenAIRealtimeControlAdapter } from '../lib/realtime/provider-adapter';

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is required.');
  const policy = loadVoiceRuntimePolicy();
  const provider = new OpenAIRealtimeControlAdapter({ apiKey });
  try {
    const result = await provider.createResponse({
      instructions: 'Reply with exactly: hello',
      input: 'Say hello. Do not use the phone.',
      model: policy.realtime.model,
      tool_choice: 'none',
      tools: [],
    }, {
      clientId: 'realtime-connectivity-check',
      requestId: 'realtime-connectivity-check',
      version: 1,
    });
    process.stdout.write(JSON.stringify({
      model: policy.realtime.model,
      ok: true,
      outputTypes: result.response.output?.map((item) => item.type) ?? [],
    }));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      errorMessage: error instanceof Error ? error.message : 'unknown error',
      errorName: error instanceof Error ? error.name : 'UnknownError',
      model: policy.realtime.model,
      ok: false,
    }));
    process.exitCode = 1;
  }
}

void main();
