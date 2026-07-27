import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const skill = async (): Promise<string> =>
  readFile(new URL('../../../hermes/skills/errandos/SKILL.md', import.meta.url), 'utf8');

const workflow = async (): Promise<string> =>
  readFile(
    new URL('../../../hermes/skills/errandos/references/blinkit-android-workflow.md', import.meta.url),
    'utf8',
  );
const rapidoWorkflow = async (): Promise<string> =>
  readFile(
    new URL('../../../hermes/skills/errandos/references/rapido-android-workflow.md', import.meta.url),
    'utf8',
  );

describe('Hermes JaldiAI skill', () => {
  it('uses the canonical asynchronous Blinkit preparation tools', async () => {
    const content = await skill();

    expect(content).toContain('`blinkit_start_prepare_cod_order`');
    expect(content).toContain('`blinkit_operation_status`');
    expect(content).not.toContain('`blinkit_prepare_cod_order`');
    expect(content).not.toContain('`prepare_grocery`');
  });

  it('distinguishes typed checkout constraints from MCP availability failures', async () => {
    const content = await skill();

    for (const reason of [
      'cod_minimum_not_met',
      'product_unavailable',
      'quantity_unavailable',
      'address_unserviceable',
      'cod_unavailable',
      'price_changed',
      'checkout_terms_unreadable',
    ]) {
      expect(content).toContain(`\`${reason}\``);
    }
    expect(content).toContain('Treat a structured `blocked` result as a reachable');
    expect(content).toContain('`itemSubtotal` and `requiredSubtotal`');
  });

  it('requires terminal polling and preserves at-most-once final actions', async () => {
    const content = await skill();
    const reference = await workflow();

    for (const status of ['`completed`', '`blocked`', '`failed`', '`expired`']) {
      expect(content).toContain(status);
    }
    expect(content).toContain('Do not let a short-lived command exit immediately');
    expect(content).toContain('Reconcile read-only and never place again');
    expect(reference).toContain('It must stop before `Place Order`');
    expect(reference).toContain('Never place a proposal after its `expiresAt`');
  });

  it('keeps raw Android controls and screen state outside the agent boundary', async () => {
    const content = await skill();

    expect(content).toContain('Never expose Appium, ADB, coordinates, selectors, UI XML, screenshots');
    expect(content).toContain('Known location prompts, review prompts, and provider overlays are handled inside JaldiAI');
  });

  it('uses the sanitized current-screen tool for bounded semantic diagnosis', async () => {
    const content = await skill();
    const reference = await workflow();

    expect(content).toContain('`blinkit_current_screen`');
    expect(content).toContain('`blinkit_share_cart`');
    expect(content).toContain('product-detail');
    expect(content).toContain('retry the original semantic operation once');
    expect(reference).toContain('`blinkit_current_screen`');
    expect(reference).not.toContain('send a screenshot');
  });

  it('uses typed failures and durable recovery tools without treating them as MCP downtime', async () => {
    const content = await skill();
    const reference = await workflow();

    expect(content).toContain('`blinkit_recent_operations`');
    expect(content).toContain('`retryable`');
    expect(content).toContain('`suggestedAction`');
    expect(content).toContain('A returned `status: failed` is a successful MCP response');
    expect(reference).toContain('`blinkit_recent_operations`');
  });

  it('selects saved addresses explicitly and compares a proposal before final placement', async () => {
    const content = await skill();
    const reference = await workflow();

    expect(content).toContain('`blinkit_select_saved_address`');
    expect(content).toContain('fresh `blinkit_list_saved_addresses` call in the same turn');
    expect(content).toContain('exact safe label as `requestedLabel`');
    expect(content).toContain('Never use `blinkit_current_screen` or conversation memory as the saved-address list');
    expect(content).toContain('`blinkit_compare_proposal`');
    expect(content).toContain('Do not place when comparison returns `changed`');
    expect(reference).toContain('`blinkit_select_saved_address`');
    expect(reference).toContain('fresh `blinkit_list_saved_addresses` call in the same turn');
    expect(reference).toContain('exact safe label as `requestedLabel`');
    expect(reference).toContain('`blinkit_compare_proposal`');
  });

  it('renders only provider-supplied optional product images', async () => {
    const content = await skill();

    expect(content).toContain('optional `imageUrl`');
    expect(content).toContain('Never guess, scrape, or substitute an image');
  });

  it('imports a shared cart before preparing it and never treats the link as approval', async () => {
    const content = await skill();
    const reference = await workflow();

    expect(content).toContain('`blinkit_import_shared_cart`');
    expect(content).toContain('A cart link is not approval');
    expect(content).toContain('`blinkit_prepare_existing_cart_cod_order`');
    expect(reference).toContain('`blinkit_import_shared_cart`');
    expect(reference).toContain('render the complete verified resulting cart');
  });

  it('uses exact Rapido ride proposals and never retries an uncertain final request', async () => {
    const content = await skill();
    const reference = await rapidoWorkflow();
    for (const tool of [
      'rapido_readiness',
      'rapido_quote_rides',
      'rapido_prepare_ride',
      'rapido_compare_proposal',
      'rapido_request_ride',
      'rapido_ride_status',
      'rapido_reconcile_ride',
      'rapido_recent_trips',
      'rapido_resend_otp',
    ]) {
      expect(`${content}\n${reference}`).toContain(`\`${tool}\``);
    }
    expect(reference).toContain('Ordinary chat text is not an approval capability');
    expect(reference).toContain('never call `rapido_request_ride` again');
    expect(reference).toContain('Never retry a final ride-request action');
  });

});
