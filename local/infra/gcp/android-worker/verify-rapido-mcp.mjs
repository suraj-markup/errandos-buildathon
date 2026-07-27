#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: '/root/product-build-repos/errandos/scripts/run-mcp-secure.sh',
});
const client = new Client({ name: 'errandos-rapido-verifier', version: '1.0.0' });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map(({ name }) => name);
  const expectedNames = [
    'blinkit_auth_status',
    'blinkit_begin_login',
    'blinkit_submit_otp',
    'blinkit_search_products',
    'blinkit_place_cod_order',
    'blinkit_order_status',
    'blinkit_reconcile_order',
    'blinkit_cart_status',
    'blinkit_prepare_existing_cart_cod_order',
    'blinkit_readiness',
    'blinkit_set_cart_item_quantity',
    'blinkit_remove_cart_item',
    'blinkit_clear_cart',
    'blinkit_add_cart_item',
    'blinkit_list_saved_addresses',
    'blinkit_recent_orders',
    'blinkit_start_prepare_cod_order',
    'blinkit_operation_status',
    'blinkit_current_screen',
    'blinkit_share_cart',
    'blinkit_compare_proposal',
    'blinkit_recent_operations',
    'blinkit_select_saved_address',
    'blinkit_import_shared_cart',
    'rapido_auth_status',
    'rapido_begin_login',
    'rapido_submit_otp',
    'rapido_readiness',
    'rapido_quote_rides',
    'rapido_prepare_ride',
    'rapido_compare_proposal',
    'rapido_request_ride',
    'rapido_ride_status',
    'rapido_reconcile_ride',
    'rapido_recent_trips',
    'rapido_resend_otp',
  ];
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    throw new Error('ErrandOS canonical MCP surface mismatch');
  }
  const result = await client.callTool({
    name: 'rapido_auth_status',
    arguments: { accountKey: 'main' },
  });
  const status = result.structuredContent?.status;
  const authentication = status === 'failed'
    && result.structuredContent?.reason === 'device_verification_failed'
    ? 'device_verification_failed'
    : status;
  if (!['active', 'login_required', 'challenge_required', 'device_verification_failed'].includes(authentication)) {
    throw new Error('Rapido authentication status unavailable');
  }
  const readiness = await client.callTool({
    name: 'rapido_readiness',
    arguments: { accountKey: 'main' },
  });
  const readinessStatus = readiness.structuredContent?.status;
  if (!['ready', 'action_required', 'unavailable'].includes(readinessStatus)) {
    throw new Error('Rapido readiness unavailable');
  }
  let resendStatus;
  if (process.env['ERRANDOS_VERIFY_RAPIDO_RESEND'] === 'true') {
    const resend = await client.callTool({
      name: 'rapido_resend_otp',
      arguments: { accountKey: 'main' },
    });
    resendStatus = resend.structuredContent?.status;
    if (!['otp_sent', 'active'].includes(resendStatus)) {
      throw new Error('Rapido OTP resend unavailable');
    }
  }
  process.stdout.write([
    `canonical_tools=${names.length}`,
    'rapido_tools=ready',
    `rapido_authentication=${authentication}`,
    `rapido_readiness=${readinessStatus}`,
    ...(resendStatus ? [`rapido_resend_otp=${resendStatus}`] : []),
  ].join('\n') + '\n');
} finally {
  await client.close();
}
