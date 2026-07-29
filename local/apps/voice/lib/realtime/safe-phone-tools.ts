import {
  executePhoneAction,
  type PhoneActionArguments,
  type PhoneActionExecutionContext,
} from '../phone-tool';
import {
  parsePhoneToolCommand,
  PhoneCommandValidationError,
} from '../phone-command';
import {
  newLocalIdentifier,
  parseLocalIdentifier,
  type LocalIdentifier,
} from '../workflow/identifiers';
import type { RealtimeFunctionTool } from './control-session';

export type RealtimePhoneToolCapability =
  | 'none'
  | 'read_only'
  | 'reversible_cart'
  | 'broader';

export type SafeRealtimeToolName =
  | 'search_products'
  | 'inspect_cart'
  | 'add_cart_item'
  | 'set_cart_item_quantity'
  | 'remove_cart_item'
  | 'prepare_checkout';

export type RealtimeToolBindingV1 = {
  itemId?: LocalIdentifier<'task_item'> | string;
  taskId: LocalIdentifier<'task'> | string;
  version: 1;
};

export type RealtimeFunctionCallV1 = {
  arguments: string;
  callId: string;
  name: string;
  version: 1;
};

export type SafeRealtimeToolResultV1 = {
  authority: 'local_phone_adapter';
  callId: string;
  operationId: LocalIdentifier<'operation'>;
  replayed: boolean;
  result: unknown;
  status: 'completed';
  toolName: SafeRealtimeToolName;
  version: 1;
};

export type SafeRealtimeToolErrorCode =
  | 'call_id_reused'
  | 'final_dispatch_forbidden'
  | 'invalid_arguments'
  | 'obsolete_task'
  | 'tool_disabled'
  | 'tool_not_permitted'
  | 'unsupported_tool';

export class SafeRealtimeToolError extends Error {
  constructor(
    readonly code: SafeRealtimeToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SafeRealtimeToolError';
  }
}

type ExecutePhoneAction = (
  action: PhoneActionArguments,
  context: PhoneActionExecutionContext,
) => Promise<unknown>;

export type SafeRealtimePhoneToolAdapterOptions = {
  authorize?: (input: {
    action: PhoneActionArguments;
    binding: Readonly<{
      itemId?: LocalIdentifier<'task_item'>;
      taskId: LocalIdentifier<'task'>;
    }>;
    call: Readonly<RealtimeFunctionCallV1>;
  }) => Promise<PhoneActionArguments> | PhoneActionArguments;
  capability: RealtimePhoneToolCapability;
  deviceTimeoutMs?: number;
  execute?: ExecutePhoneAction;
  isCurrentTask?: (
    binding: Readonly<{
      itemId?: LocalIdentifier<'task_item'>;
      taskId: LocalIdentifier<'task'>;
    }>,
  ) => boolean;
  maxReplayEntries?: number;
  queueTimeoutMs?: number;
};

type ReplayEntry = {
  fingerprint: string;
  promise: Promise<SafeRealtimeToolResultV1>;
};

const readOnlyTools = new Set<SafeRealtimeToolName>([
  'inspect_cart',
  'search_products',
]);

const reversibleTools = new Set<SafeRealtimeToolName>([
  ...readOnlyTools,
  'add_cart_item',
  'prepare_checkout',
  'remove_cart_item',
  'set_cart_item_quantity',
]);

const schemas: Readonly<Record<SafeRealtimeToolName, RealtimeFunctionTool>> = {
  search_products: {
    type: 'function',
    name: 'search_products',
    description: 'Search visible Blinkit product options. Never changes the cart.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        request: { type: 'string', minLength: 1, maxLength: 200 },
      },
      required: ['request'],
    },
  },
  inspect_cart: {
    type: 'function',
    name: 'inspect_cart',
    description: 'Read the current cart without changing it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  add_cart_item: {
    type: 'function',
    name: 'add_cart_item',
    description: 'Add an exact previously selected offer to the cart.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        offerId: { type: 'string', minLength: 1, maxLength: 200 },
        quantity: { type: 'integer', minimum: 1, maximum: 20 },
        request: { type: 'string', minLength: 1, maxLength: 200 },
      },
      required: ['offerId', 'quantity', 'request'],
    },
  },
  set_cart_item_quantity: {
    type: 'function',
    name: 'set_cart_item_quantity',
    description: 'Set the quantity of an exact cart line.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        productId: { type: 'string', minLength: 1, maxLength: 200 },
        quantity: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['productId', 'quantity'],
    },
  },
  remove_cart_item: {
    type: 'function',
    name: 'remove_cart_item',
    description: 'Remove an exact cart line.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        productId: { type: 'string', minLength: 1, maxLength: 200 },
      },
      required: ['productId'],
    },
  },
  prepare_checkout: {
    type: 'function',
    name: 'prepare_checkout',
    description: 'Read and prepare checkout terms. Never places an order.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
};

const toolKeys: Readonly<
  Record<SafeRealtimeToolName, {
    allowed: ReadonlySet<string>;
    required: ReadonlySet<string>;
  }>
> = {
  search_products: {
    allowed: new Set(['request']),
    required: new Set(['request']),
  },
  inspect_cart: {
    allowed: new Set(),
    required: new Set(),
  },
  add_cart_item: {
    allowed: new Set(['offerId', 'quantity', 'request']),
    required: new Set(['offerId', 'quantity', 'request']),
  },
  set_cart_item_quantity: {
    allowed: new Set(['productId', 'quantity']),
    required: new Set(['productId', 'quantity']),
  },
  remove_cart_item: {
    allowed: new Set(['productId']),
    required: new Set(['productId']),
  },
  prepare_checkout: {
    allowed: new Set(),
    required: new Set(),
  },
};

function toolNamesForCapability(
  capability: RealtimePhoneToolCapability,
): readonly SafeRealtimeToolName[] {
  if (capability === 'none') return [];
  if (capability === 'read_only') return [...readOnlyTools];
  return [...reversibleTools];
}

export function realtimePhoneToolDefinitions(
  capability: RealtimePhoneToolCapability,
): RealtimeFunctionTool[] {
  return toolNamesForCapability(capability).map((name) => ({
    ...schemas[name],
    parameters: { ...schemas[name].parameters },
  }));
}

function safeCallId(value: unknown): string {
  if (
    typeof value !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,199}$/.test(value)
  ) {
    throw new SafeRealtimeToolError(
      'invalid_arguments',
      'Realtime function call ID is invalid.',
    );
  }
  return value;
}

function safeBinding(binding: RealtimeToolBindingV1): {
  itemId?: LocalIdentifier<'task_item'>;
  taskId: LocalIdentifier<'task'>;
} {
  if (binding.version !== 1) {
    throw new SafeRealtimeToolError(
      'invalid_arguments',
      'Realtime tool binding version is unsupported.',
    );
  }
  try {
    return {
      taskId: parseLocalIdentifier('task', binding.taskId),
      ...(binding.itemId
        ? { itemId: parseLocalIdentifier('task_item', binding.itemId) }
        : {}),
    };
  } catch {
    throw new SafeRealtimeToolError(
      'invalid_arguments',
      'Realtime tools require current local task correlation.',
    );
  }
}

function normalizedToolName(value: string): SafeRealtimeToolName {
  if (value === 'confirm_checkout') {
    throw new SafeRealtimeToolError(
      'final_dispatch_forbidden',
      'Final order dispatch is unavailable to Realtime.',
    );
  }
  if (!(value in schemas)) {
    throw new SafeRealtimeToolError(
      'unsupported_tool',
      `Unsupported Realtime phone tool: ${value}.`,
    );
  }
  return value as SafeRealtimeToolName;
}

function fingerprint(input: {
  arguments: string;
  binding: {
    itemId?: LocalIdentifier<'task_item'>;
    taskId: LocalIdentifier<'task'>;
  };
  name: SafeRealtimeToolName;
}): string {
  return JSON.stringify({
    arguments: input.arguments,
    itemId: input.binding.itemId ?? null,
    name: input.name,
    taskId: input.binding.taskId,
  });
}

function assertStrictToolShape(
  name: SafeRealtimeToolName,
  serializedArguments: string,
): void {
  let value: unknown;
  try {
    value = JSON.parse(serializedArguments);
  } catch {
    throw new SafeRealtimeToolError(
      'invalid_arguments',
      'The phone command arguments were not valid JSON.',
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SafeRealtimeToolError(
      'invalid_arguments',
      'The phone command arguments must be an object.',
    );
  }
  const keys = Object.keys(value);
  const policy = toolKeys[name];
  if (keys.some((key) => !policy.allowed.has(key))) {
    throw new SafeRealtimeToolError(
      'invalid_arguments',
      'The phone command contains an undeclared argument.',
    );
  }
  if ([...policy.required].some((key) => !(key in value))) {
    throw new SafeRealtimeToolError(
      'invalid_arguments',
      'The phone command is missing a required argument.',
    );
  }
}

const MODEL_OUTPUT_PRIVATE_FIELD =
  /address|authorization|bounds|card|confirmationPhrase|coordinate|evidence|fingerprint|image|idempotency|otp|payment|phone|providerReference|proposalHash|screenshot|secret|token/i;

function modelSafeToolResult(
  value: unknown,
  seen = new Set<object>(),
): unknown {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => modelSafeToolResult(entry, seen));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !MODEL_OUTPUT_PRIVATE_FIELD.test(key))
      .map(([key, nested]) => [key, modelSafeToolResult(nested, seen)]),
  );
}

export class SafeRealtimePhoneToolAdapter {
  private readonly authorize: NonNullable<
    SafeRealtimePhoneToolAdapterOptions['authorize']
  >;
  private readonly capability: RealtimePhoneToolCapability;
  private readonly deviceTimeoutMs: number | undefined;
  private readonly executeAction: ExecutePhoneAction;
  private readonly isCurrentTask: NonNullable<
    SafeRealtimePhoneToolAdapterOptions['isCurrentTask']
  >;
  private readonly maxReplayEntries: number;
  private readonly queueTimeoutMs: number | undefined;
  private readonly replay = new Map<string, ReplayEntry>();

  constructor(options: SafeRealtimePhoneToolAdapterOptions) {
    this.authorize = options.authorize
      ?? (({ action }) => action);
    this.capability = options.capability;
    this.deviceTimeoutMs = options.deviceTimeoutMs;
    this.executeAction = options.execute ?? executePhoneAction;
    this.isCurrentTask = options.isCurrentTask ?? (() => true);
    this.maxReplayEntries = options.maxReplayEntries ?? 256;
    this.queueTimeoutMs = options.queueTimeoutMs;
    if (!Number.isInteger(this.maxReplayEntries) || this.maxReplayEntries < 1) {
      throw new Error('maxReplayEntries must be a positive integer.');
    }
  }

  definitions(): RealtimeFunctionTool[] {
    return realtimePhoneToolDefinitions(this.capability);
  }

  async execute(
    call: RealtimeFunctionCallV1,
    rawBinding: RealtimeToolBindingV1,
  ): Promise<SafeRealtimeToolResultV1> {
    const callId = safeCallId(call.callId);
    if (call.version !== 1 || typeof call.arguments !== 'string') {
      throw new SafeRealtimeToolError(
        'invalid_arguments',
        'Realtime function call payload is invalid.',
      );
    }
    const name = normalizedToolName(call.name);
    const permitted = toolNamesForCapability(this.capability);
    if (this.capability === 'none') {
      throw new SafeRealtimeToolError(
        'tool_disabled',
        'Realtime phone tools are disabled.',
      );
    }
    if (!permitted.includes(name)) {
      throw new SafeRealtimeToolError(
        'tool_not_permitted',
        `${name} is not permitted in the current Realtime rollout stage.`,
      );
    }
    const binding = safeBinding(rawBinding);
    if (!this.isCurrentTask(binding)) {
      throw new SafeRealtimeToolError(
        'obsolete_task',
        'The Realtime function call belongs to an obsolete task.',
      );
    }
    const callFingerprint = fingerprint({
      arguments: call.arguments,
      binding,
      name,
    });
    const previous = this.replay.get(callId);
    if (previous) {
      if (previous.fingerprint !== callFingerprint) {
        throw new SafeRealtimeToolError(
          'call_id_reused',
          'Realtime function call ID was reused with different arguments.',
        );
      }
      const result = await previous.promise;
      return { ...result, replayed: true };
    }

    let parsed: PhoneActionArguments;
    try {
      assertStrictToolShape(name, call.arguments);
      parsed = parsePhoneToolCommand(name, call.arguments, {
        protocolVersion: 2,
      });
    } catch (error) {
      if (error instanceof PhoneCommandValidationError) {
        throw new SafeRealtimeToolError('invalid_arguments', error.message);
      }
      throw error;
    }
    const operationId = newLocalIdentifier('operation');
    const promise = Promise.resolve(this.authorize({
      action: parsed,
      binding,
      call,
    })).then((action) => this.executeAction(action, {
      operationId,
      taskId: binding.taskId,
      ...(binding.itemId ? { itemId: binding.itemId } : {}),
      ...(this.queueTimeoutMs === undefined
        ? {}
        : { queueTimeoutMs: this.queueTimeoutMs }),
      ...(this.deviceTimeoutMs === undefined
        ? {}
        : { deviceTimeoutMs: this.deviceTimeoutMs }),
      isCurrent: () => this.isCurrentTask(binding),
    })).then((result): SafeRealtimeToolResultV1 => ({
      authority: 'local_phone_adapter',
      callId,
      operationId,
      replayed: false,
      result,
      status: 'completed',
      toolName: name,
      version: 1,
    }));
    this.replay.set(callId, { fingerprint: callFingerprint, promise });
    while (this.replay.size > this.maxReplayEntries) {
      const oldest = this.replay.keys().next().value as string | undefined;
      if (!oldest) break;
      this.replay.delete(oldest);
    }
    return promise;
  }

  functionCallOutput(
    result: SafeRealtimeToolResultV1,
  ): Record<string, unknown> {
    return {
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: result.callId,
        output: JSON.stringify({
          authority: result.authority,
          operationId: result.operationId,
          result: modelSafeToolResult(result.result),
          status: result.status,
          toolName: result.toolName,
          version: result.version,
        }),
      },
    };
  }
}
