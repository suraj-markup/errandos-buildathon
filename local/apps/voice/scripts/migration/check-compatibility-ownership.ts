import { resolve } from 'node:path';
import { inspectCompatibilityOwnershipV1 } from './compatibility-ownership.ts';

const rootDir = resolve(import.meta.dirname, '../..');
const report = await inspectCompatibilityOwnershipV1(rootDir);
for (const entry of report.inventory) {
  process.stdout.write(
    `${entry.category} ${entry.id}: ${entry.occurrences.length} occurrence(s)\n`,
  );
  entry.occurrences.forEach(({ file, line }) => {
    process.stdout.write(`  ${file}:${line}\n`);
  });
  entry.removalPrerequisites.forEach(({ id, requirement }) => {
    process.stdout.write(`  REMOVE AFTER ${id}: ${requirement}\n`);
  });
}
if (report.violations.length > 0) {
  report.violations.forEach((violation) => {
    process.stderr.write(
      `VIOLATION ${violation.surfaceId} ${violation.type}: `
      + `${violation.file} has ${violation.actual}; allowed ${violation.allowed}\n`,
    );
  });
  process.exitCode = 1;
}
