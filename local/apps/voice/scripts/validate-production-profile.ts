import {
  requireProductionProfile,
  ProductionProfileValidationError,
} from './production-profile.ts';

try {
  const profile = requireProductionProfile(process.env);
  process.stdout.write(`${JSON.stringify({
    appiumOrigin: profile.appium.origin,
    deviceSelected: true,
    mode: profile.mode,
    ok: true,
    providers: profile.providers,
  })}\n`);
} catch (error) {
  if (error instanceof ProductionProfileValidationError) {
    process.stderr.write(`${JSON.stringify({
      issues: error.issues,
      ok: false,
    })}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
