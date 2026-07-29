import {
  formatConnectivitySnapshot,
  loadConnectivityPreflightConfig,
  parseConnectivityPreflightArguments,
  runConnectivityKeepAlive,
  runConnectivityPreflight,
} from './ux079-connectivity-preflight.ts';

async function main(): Promise<void> {
  const config = loadConnectivityPreflightConfig(process.env);
  const arguments_ = parseConnectivityPreflightArguments(
    process.argv.slice(2),
  );
  if (!arguments_.keepAlive) {
    const snapshot = await runConnectivityPreflight(config);
    process.stdout.write(`${formatConnectivitySnapshot(snapshot)}\n`);
    if (!snapshot.ready) process.exitCode = 1;
    return;
  }

  const cancellation = new AbortController();
  process.once('SIGINT', () => cancellation.abort());
  process.once('SIGTERM', () => cancellation.abort());
  await runConnectivityKeepAlive({
    intervalMs: arguments_.intervalMs,
    maxIterations: arguments_.maxIterations,
    onSnapshot: (snapshot) => {
      process.stdout.write(`${formatConnectivitySnapshot(snapshot)}\n`);
      if (!snapshot.ready) {
        process.exitCode = 1;
        cancellation.abort();
      }
    },
    probe: () => runConnectivityPreflight(config),
    signal: cancellation.signal,
  });
}

void main().catch(() => {
  // Configuration and transport errors intentionally omit values and provider
  // responses so credentials can never reach stdout/stderr.
  process.stderr.write('Connectivity preflight could not start safely.\n');
  process.exitCode = 1;
});
