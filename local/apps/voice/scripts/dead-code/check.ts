import { resolve } from 'node:path';
import {
  analyzeDeadCodeV1,
  readDeadCodeInputsV1,
} from './analyzer.ts';

const mode = process.argv.includes('--report') ? 'report' : 'check';
const rootDir = resolve(import.meta.dirname, '../..');
const { config, manifest } = await readDeadCodeInputsV1(rootDir);
const report = await analyzeDeadCodeV1({
  rootDir,
  config,
  manifest,
  today: new Date().toISOString().slice(0, 10),
});

if (mode === 'report') {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(
    `Dead-code check: ${report.violations.length} violation(s), `
    + `${report.suppressed.length} reviewed exception(s), `
    + `${report.manifestErrors.length} manifest error(s).\n`,
  );
  report.violations.forEach((finding) => {
    process.stdout.write(`  VIOLATION ${finding.kind}: ${finding.target}\n`);
  });
  report.manifestErrors.forEach((error) => {
    process.stdout.write(`  MANIFEST: ${error}\n`);
  });
  const exceptionSummaries = new Map<string, number>();
  report.suppressed.forEach(({ exception }) => {
    const key = `${exception.owner} until ${exception.removeBy}`;
    exceptionSummaries.set(key, (exceptionSummaries.get(key) ?? 0) + 1);
  });
  [...exceptionSummaries].sort(([left], [right]) =>
    left.localeCompare(right)).forEach(([key, count]) => {
    process.stdout.write(`  REVIEWED ${count}: ${key}\n`);
  });
  if (report.violations.length > 0 || report.manifestErrors.length > 0) {
    process.exitCode = 1;
  }
}
