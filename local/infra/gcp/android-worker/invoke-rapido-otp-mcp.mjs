#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const otp = await readSecretLine();
if (!/^\d{4,8}$/.test(otp)) process.exit(2);

const transport = new StdioClientTransport({
  command: '/root/product-build-repos/errandos/scripts/run-mcp-secure.sh',
});
const client = new Client({ name: 'errandos-rapido-otp', version: '1.0.0' });

try {
  await client.connect(transport);
  const result = await client.callTool({
    name: 'rapido_submit_otp',
    arguments: { accountKey: 'main', otp },
  });
  const status = result.structuredContent?.status;
  if (!['active', 'challenge_required'].includes(status)) {
    const reason = result.structuredContent?.reason;
    process.stdout.write(`rapido_otp=failed\nreason=${safeToken(reason)}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`rapido_otp=${status}\n`);
  }
} finally {
  await client.close();
}

async function readSecretLine() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    const newline = input.indexOf('\n');
    if (newline >= 0) return input.slice(0, newline).trim();
    if (input.length > 64) process.exit(2);
  }
  return input.trim();
}

function safeToken(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{1,63}$/.test(value)
    ? value
    : 'operation_failed';
}
