import {
  openBlinkit,
  placeCodOrder,
  prepareCodCheckout,
  readPhoneStatus,
} from './appium';
import { prepareGroceryWithHostedDriver } from './hosted-blinkit';

export type PhoneActionArguments = {
  action?:
    | 'phone_status'
    | 'open_blinkit'
    | 'prepare_grocery'
    | 'prepare_cod_checkout'
    | 'confirm_cod_order';
  expectedFingerprint?: string;
  offerId?: string;
  request?: string;
  searchQuery?: string;
};

export async function executePhoneAction(arguments_: PhoneActionArguments) {
  switch (arguments_.action) {
    case 'phone_status':
      return { ok: true, result: await readPhoneStatus() };
    case 'open_blinkit':
      return { ok: true, result: await openBlinkit() };
    case 'prepare_grocery':
      return prepareGroceryWithHostedDriver(
        arguments_.request ?? '',
        arguments_.searchQuery,
        arguments_.offerId,
      );
    case 'prepare_cod_checkout':
      return prepareCodCheckout();
    case 'confirm_cod_order':
      return placeCodOrder(arguments_.expectedFingerprint ?? '');
    default:
      return {
        ok: false,
        status: 'unsupported_action',
        message: 'The requested phone action is not supported.',
      };
  }
}
