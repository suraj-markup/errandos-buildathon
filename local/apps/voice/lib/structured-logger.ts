import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  stageMetrics,
  type MetricStage,
} from './stage-metrics';
import {
  runWithStageDeadline,
  stageDeadlinePolicy,
  type DeadlineStage,
  StageDeadlineExceededError,
} from './stage-deadlines';

type LogContext = {
  clarificationId?: string;
  clientId?: string;
  itemId?: string;
  observationId?: string;
  operationId?: string;
  realtimeSessionId?: string;
  requestId: string;
  route: string;
  selectionId?: string;
  taskId?: string;
};

type LogData = Record<string, unknown>;

type LogLevel = 'error' | 'info' | 'warn';

type LogSink = (line: string) => void;

const sensitiveKeyPattern =
  /address|api.?key|audio(?:base64)?|authorization|card|expectedFingerprint|image|otp|password|payment|phone|screenshot|secret|token/i;
const sensitiveContentKeys = new Set([
  'arguments',
  'confirmationphrase',
  'errorcause',
  'errormessage',
  'input',
  'itemnames',
  'label',
  'message',
  'modelinput',
  'nextproduct',
  'options',
  'output',
  'product',
  'providerreference',
  'reply',
  'request',
  'searchquery',
  'responsetext',
  'selectedoption',
  'serializedarguments',
  'spokenlabel',
  'spokentext',
  'text',
  'title',
  'toolarguments',
  'transcript',
]);
const longIdentifierPattern = /fingerprint/i;
const maxArrayItems = 20;
const maxDepth = 6;
const maxStringLength = 800;

function localContentLoggingEnabled(): boolean {
  const configured = process.env.JALDI_LOG_CONTENT_V1
    ?.trim()
    .toLocaleLowerCase('en-US');
  return process.env.NODE_ENV !== 'production'
    && (configured === '1' || configured === 'true');
}

const loggerGlobal = globalThis as typeof globalThis & {
  errandosLogContext?: AsyncLocalStorage<LogContext>;
};

const logContext =
  loggerGlobal.errandosLogContext ?? new AsyncLocalStorage<LogContext>();
loggerGlobal.errandosLogContext = logContext;

function truncate(value: string, maximum = maxStringLength): string {
  return value.length > maximum
    ? `${value.slice(0, maximum)}…[${value.length - maximum} more chars]`
    : value;
}

function sanitizeValue(
  value: unknown,
  key = '',
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  const normalizedKey = key.replaceAll(/[^a-z0-9]/gi, '').toLowerCase();
  if (
    sensitiveKeyPattern.test(key)
    || (
      sensitiveContentKeys.has(normalizedKey)
      && !localContentLoggingEnabled()
    )
  ) {
    return '[redacted]';
  }
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (longIdentifierPattern.test(key) && value.length > 16) {
      return `${value.slice(0, 8)}…${value.slice(-4)}`;
    }
    return truncate(value.replaceAll(/\s+/g, ' ').trim());
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
  if (depth >= maxDepth) return '[max-depth]';
  if (Array.isArray(value)) {
    return value
      .slice(0, maxArrayItems)
      .map((item) => sanitizeValue(item, key, depth + 1, seen));
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const entries = Object.entries(value as Record<string, unknown>)
      .slice(0, 60)
      .map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeValue(entryValue, entryKey, depth + 1, seen),
      ]);
    return Object.fromEntries(entries);
  }
  return truncate(String(value));
}

export function sanitizeLogData(data: LogData): LogData {
  return sanitizeValue(data) as LogData;
}

export function newRequestId(): string {
  return randomUUID();
}

export function withLogContext<T>(
  context: LogContext,
  run: () => T,
): T {
  return logContext.run(context, run);
}

export function updateLogContext(context: Partial<LogContext>): void {
  const active = logContext.getStore();
  if (active) Object.assign(active, context);
}

function metricStageForFunction(functionName: string): MetricStage | undefined {
  if (functionName === 'provider.sarvam.transcribe') return 'transcript';
  if (functionName === 'provider.sarvam.synthesize') return 'synthesis';
  if (functionName === 'provider.openai.responses') return 'model';
  if (functionName.startsWith('workflow.')) return 'workflow';
  return undefined;
}

function deadlineStageForFunction(
  functionName: string,
): DeadlineStage | undefined {
  if (functionName === 'provider.sarvam.transcribe') return 'sarvam_stt';
  if (functionName === 'provider.sarvam.synthesize') return 'sarvam_tts';
  if (functionName === 'provider.openai.responses') return 'control_model';
  return undefined;
}

function defaultSink(level: LogLevel): LogSink {
  return level === 'error'
    ? (line) => console.error(line)
    : level === 'warn'
      ? (line) => console.warn(line)
      : (line) => console.info(line);
}

export function logEvent(
  level: LogLevel,
  event: string,
  data: LogData = {},
  sink: LogSink = defaultSink(level),
): void {
  const context = logContext.getStore();
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...sanitizeLogData(data),
    ...(context ?? {}),
  };
  sink(JSON.stringify(entry));
}

export function errorDetails(error: unknown): LogData {
  return error instanceof StageDeadlineExceededError
    ? {
        errorName: error.name,
        errorCode: error.code,
        deadlineStage: error.stage,
        timeoutMs: error.timeoutMs,
        recoveryAction: error.recoveryAction,
      }
    : error instanceof Error
    ? {
        errorName: error.name,
        errorMessage: error.message,
        ...(error.cause ? { errorCause: error.cause } : {}),
      }
    : { errorMessage: String(error) };
}

export async function traceFunction<T>(
  functionName: string,
  data: LogData,
  run: () => Promise<T>,
  summarizeResult: (result: T) => LogData = () => ({}),
): Promise<T> {
  const startedAt = performance.now();
  const metricStage = metricStageForFunction(functionName);
  const deadlineStage = deadlineStageForFunction(functionName);
  const context = logContext.getStore();
  const metricTimer = metricStage
    ? stageMetrics.begin(metricStage, {
        ...(context?.clarificationId
          ? { clarificationId: context.clarificationId }
          : {}),
        ...(context?.clientId ? { clientId: context.clientId } : {}),
        ...(context?.itemId ? { itemId: context.itemId } : {}),
        ...(context?.observationId
          ? { observationId: context.observationId }
          : {}),
        ...(context?.operationId
          ? { operationId: context.operationId }
          : {}),
        ...(context?.realtimeSessionId
          ? { realtimeSessionId: context.realtimeSessionId }
          : {}),
        ...(context?.requestId ? { requestId: context.requestId } : {}),
        ...(context?.selectionId
          ? { selectionId: context.selectionId }
          : {}),
        ...(context?.taskId ? { taskId: context.taskId } : {}),
      })
    : undefined;
  logEvent('info', 'function.start', { functionName, ...data });
  try {
    const result = deadlineStage
      ? await runWithStageDeadline({
          run: async () => run(),
          stage: deadlineStage,
          timeoutMs: stageDeadlinePolicy.timeoutFor(deadlineStage),
        })
      : await run();
    if (metricTimer) {
      logEvent('info', 'metric.stage', metricTimer.finish({
        outcome: 'completed',
      }));
    }
    logEvent('info', 'function.complete', {
      functionName,
      durationMs: Math.round(performance.now() - startedAt),
      ...summarizeResult(result),
    });
    return result;
  } catch (error) {
    if (metricTimer) {
      logEvent('warn', 'metric.stage', metricTimer.finish({
        fallbackReason: 'function_error',
        outcome: 'error',
      }));
    }
    logEvent('error', 'function.error', {
      functionName,
      durationMs: Math.round(performance.now() - startedAt),
      ...errorDetails(error),
    });
    throw error;
  }
}
