import type { PhoneActionArguments } from './phone-tool';
import { parseLocalIdentifier } from './workflow/identifiers';

export const canonicalPhoneCommandsV2 = [
  'add_cart_item',
  'cancel_current_task',
  'confirm_checkout',
  'inspect_cart',
  'open_blinkit',
  'phone_status',
  'prepare_checkout',
  'remove_cart_item',
  'search_products',
  'set_cart_item_quantity',
] as const;

type PhoneCommandProtocolVersion = 1 | 2;

type PhoneCommandProtocolOptions = {
  protocolVersion: PhoneCommandProtocolVersion;
};

export class PhoneCommandValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PhoneCommandValidationError';
  }
}

function protocolVersion(
  options: PhoneCommandProtocolOptions | undefined,
): PhoneCommandProtocolVersion {
  // Canonical V2 is the production default. The bounded V1 compatibility
  // surface must always be requested explicitly by its remaining owner.
  const version = options?.protocolVersion ?? 2;
  if (version !== 1 && version !== 2) {
    throw new PhoneCommandValidationError(
      `Unsupported phone command protocol version: ${String(version)}.`,
    );
  }
  return version;
}

function recordFrom(serialized: string | undefined): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized ?? '{}');
  } catch {
    throw new PhoneCommandValidationError('The phone command arguments were not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PhoneCommandValidationError('The phone command arguments must be an object.');
  }
  return parsed as Record<string, unknown>;
}

function requiredText(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new PhoneCommandValidationError(`${key} is required.`);
  }
  return value.trim().slice(0, 200);
}

function optionalOfferId(record: Record<string, unknown>): string | undefined {
  const value = record['offerId'];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new PhoneCommandValidationError('offerId must be a valid pending offer ID.');
  }
  return value.trim();
}

function requiredProductId(record: Record<string, unknown>): string {
  const value = record['productId'];
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new PhoneCommandValidationError('productId must be an exact cart product ID.');
  }
  return value.trim();
}

function requiredQuantity(record: Record<string, unknown>): number {
  const value = record['quantity'];
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 20) {
    throw new PhoneCommandValidationError('quantity must be a whole number between 1 and 20.');
  }
  return value as number;
}

function optionalTaskId(
  record: Record<string, unknown>,
): string | undefined {
  const value = record['taskId'];
  if (value === undefined) return undefined;
  try {
    return parseLocalIdentifier('task', value);
  } catch {
    throw new PhoneCommandValidationError(
      'taskId must identify the current local phone task.',
    );
  }
}

export function parsePhoneToolCommand(
  callName: string,
  serializedArguments?: string,
  options?: PhoneCommandProtocolOptions,
): PhoneActionArguments {
  protocolVersion(options);
  const record = recordFrom(serializedArguments);
  switch (callName) {
    case 'search_products':
      return {
        action: 'search_products',
        request: requiredText(record, 'request'),
      };
    case 'inspect_cart':
      return { action: 'inspect_cart' };
    case 'add_cart_item':
      {
        const offerId = optionalOfferId(record);
        return {
          action: 'add_cart_item',
          request: requiredText(record, 'request'),
          quantity: requiredQuantity(record),
          ...(offerId ? { offerId } : {}),
        };
      }
    case 'set_cart_item_quantity':
      return {
        action: 'set_cart_item_quantity',
        productId: requiredProductId(record),
        quantity: requiredQuantity(record),
      };
    case 'remove_cart_item':
      return {
        action: 'remove_cart_item',
        productId: requiredProductId(record),
      };
    case 'prepare_checkout':
      return { action: 'prepare_checkout' };
    case 'confirm_checkout':
      return { action: 'confirm_checkout' };
    case 'open_blinkit':
      return { action: 'open_blinkit' };
    case 'phone_status':
      return { action: 'phone_status' };
    case 'cancel_current_task':
      {
        const taskId = optionalTaskId(record);
        return {
          action: 'cancel_current_task',
          ...(taskId ? { taskId } : {}),
        };
      }
    default:
      throw new PhoneCommandValidationError(`Unsupported phone command: ${callName}.`);
  }
}

export function parseDirectPhoneTask(
  value: unknown,
  options?: PhoneCommandProtocolOptions,
): PhoneActionArguments {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PhoneCommandValidationError('Phone task arguments must be an object.');
  }
  const record = value as Record<string, unknown>;
  protocolVersion(options);
  switch (record['action']) {
    case 'phone_status':
      return { action: 'phone_status' };
    case 'open_blinkit':
      return { action: 'open_blinkit' };
    case 'inspect_cart':
      return { action: 'inspect_cart' };
    case 'search_products':
      return {
        action: 'search_products',
        request: requiredText(record, 'request'),
      };
    case 'cancel_current_task':
      {
        const taskId = optionalTaskId(record);
        if (!taskId) {
          throw new PhoneCommandValidationError(
            'taskId is required to cancel a direct phone task.',
          );
        }
        return { action: 'cancel_current_task', taskId };
      }
    default:
      throw new PhoneCommandValidationError('The direct phone task is not supported.');
  }
}
