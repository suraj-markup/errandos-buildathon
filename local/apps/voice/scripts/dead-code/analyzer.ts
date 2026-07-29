import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

export type DeadCodeConfigV1 = {
  version: 1;
  sourcePatterns: string[];
  productionEntrypoints: string[];
  testEntrypoints: string[];
  scriptEntrypoints: string[];
  exceptionManifest: string;
};

type DeadCodeExceptionMetadataV1 = {
  category: 'compatibility' | 'feature_flag';
  owner: string;
  removeBy: string;
  reason: string;
};

export type DeadCodeExceptionV1 = DeadCodeExceptionMetadataV1 & (
  | DeadCodeFindingV1
  | { findings: DeadCodeFindingV1[] }
);

export type DeadCodeManifestV1 = {
  version: 1;
  exceptions: DeadCodeExceptionV1[];
};

export type DeadCodeFindingV1 =
  | { kind: 'file'; target: string }
  | { kind: 'export'; target: string };

export type DeadCodeReportV1 = {
  version: 1;
  entrypoints: {
    production: string[];
    test: string[];
    script: string[];
  };
  reachability: {
    production: string[];
    testOnly: string[];
    scriptOnly: string[];
    sharedNonProduction: string[];
  };
  findings: DeadCodeFindingV1[];
  suppressed: Array<{
    finding: DeadCodeFindingV1;
    exception: DeadCodeExceptionV1;
  }>;
  violations: DeadCodeFindingV1[];
  manifestErrors: string[];
};

type ModuleFacts = {
  dependencies: string[];
  exports: string[];
  usedExportsByDependency: Map<string, Set<string>>;
};

const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts'] as const;

function slash(value: string): string {
  return value.split(sep).join('/');
}

function globRegex(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if ('\\.^$+?()[]{}|'.includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`${source}$`);
}

function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globRegex(pattern).test(path));
}

async function walk(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (['.git', '.next', 'node_modules', 'test-artifacts'].includes(entry.name)) {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await visit(root);
  return files;
}

function exportedBindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element)
      ? []
      : exportedBindingNames(element.name));
}

function hasExportModifier(node: ts.HasModifiers): boolean {
  return Boolean(ts.getModifiers(node)?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  ));
}

function moduleFacts(source: string, fileName: string): {
  facts: Omit<ModuleFacts, 'dependencies' | 'usedExportsByDependency'>;
  imports: Array<{ specifier: string; names: string[] }>;
} {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const exports = new Set<string>();
  const imports: Array<{ specifier: string; names: string[] }> = [];
  const addImport = (specifier: string, names: string[]): void => {
    if (specifier.startsWith('.')) imports.push({ specifier, names });
  };

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)
        && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      const names: string[] = [];
      if (clause?.name) names.push('default');
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) names.push('*');
        else {
          for (const element of clause.namedBindings.elements) {
            names.push((element.propertyName ?? element.name).text);
          }
        }
      }
      addImport(statement.moduleSpecifier.text, names);
    } else if (
      ts.isExportDeclaration(statement)
      && statement.moduleSpecifier
      && ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      if (!statement.exportClause) {
        addImport(statement.moduleSpecifier.text, ['*']);
      } else if (ts.isNamedExports(statement.exportClause)) {
        const names = statement.exportClause.elements.map(
          (element) => (element.propertyName ?? element.name).text,
        );
        addImport(statement.moduleSpecifier.text, names);
        statement.exportClause.elements.forEach(
          (element) => exports.add(element.name.text),
        );
      }
    }

    if (
      (
        ts.isFunctionDeclaration(statement)
        || ts.isClassDeclaration(statement)
        || ts.isInterfaceDeclaration(statement)
        || ts.isTypeAliasDeclaration(statement)
        || ts.isEnumDeclaration(statement)
      )
      && hasExportModifier(statement)
    ) {
      if (statement.name) exports.add(statement.name.text);
      if (ts.getModifiers(statement)?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
      )) {
        exports.add('default');
      }
    } else if (
      ts.isVariableStatement(statement)
      && hasExportModifier(statement)
    ) {
      statement.declarationList.declarations.forEach((declaration) =>
        exportedBindingNames(declaration.name).forEach((name) => exports.add(name)));
    } else if (
      ts.isExportAssignment(statement)
    ) {
      exports.add('default');
    } else if (
      ts.isExportDeclaration(statement)
      && !statement.moduleSpecifier
      && statement.exportClause
      && ts.isNamedExports(statement.exportClause)
    ) {
      statement.exportClause.elements.forEach(
        (element) => exports.add(element.name.text),
      );
    }
  }

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node)
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0]!)
      && (
        node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (
          ts.isIdentifier(node.expression)
          && node.expression.text === 'require'
        )
      )
    ) {
      addImport(node.arguments[0].text, ['*']);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return {
    facts: { exports: [...exports].sort() },
    imports,
  };
}

function resolveDependency(
  importer: string,
  specifier: string,
  sourceFiles: ReadonlySet<string>,
): string | undefined {
  const base = resolve(dirname(importer), specifier);
  const candidates = [
    base,
    ...sourceExtensions.map((extension) => `${base}${extension}`),
    ...sourceExtensions.map((extension) => join(base, `index${extension}`)),
  ];
  return candidates.find((candidate) => sourceFiles.has(candidate));
}

function reachable(
  roots: readonly string[],
  facts: ReadonlyMap<string, ModuleFacts>,
): Set<string> {
  const visited = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (visited.has(path)) continue;
    visited.add(path);
    for (const dependency of facts.get(path)?.dependencies ?? []) {
      if (!visited.has(dependency)) queue.push(dependency);
    }
  }
  return visited;
}

function manifestErrors(
  manifest: DeadCodeManifestV1,
  today: string,
): string[] {
  const errors: string[] = [];
  if (manifest.version !== 1 || !Array.isArray(manifest.exceptions)) {
    return ['Exception manifest must be version 1.'];
  }
  if (manifest.exceptions.length > 32) {
    errors.push('Exception manifest exceeds the 32-entry limit.');
  }
  const targets = new Set<string>();
  const todayTime = Date.parse(`${today}T00:00:00Z`);
  const latestRemovalTime = todayTime + (90 * 24 * 60 * 60 * 1000);
  manifest.exceptions.forEach((exception, index) => {
    const prefix = `Exception ${index}`;
    if (!['compatibility', 'feature_flag'].includes(exception.category)) {
      errors.push(`${prefix} has an invalid category.`);
    }
    if (!exception.owner?.trim()) errors.push(`${prefix} requires an owner.`);
    if (!exception.reason?.trim() || exception.reason.trim().length < 12) {
      errors.push(`${prefix} requires a specific reason of at least 12 characters.`);
    }
    const removalTime = Date.parse(`${exception.removeBy}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(exception.removeBy)
      || !Number.isFinite(removalTime)
    ) {
      errors.push(`${prefix} requires removeBy in YYYY-MM-DD format.`);
    } else if (removalTime < todayTime) {
      errors.push(`${prefix} expired on ${exception.removeBy}.`);
    } else if (removalTime > latestRemovalTime) {
      errors.push(`${prefix} removeBy must be within 90 days.`);
    }
    const findings = 'findings' in exception
      ? exception.findings
      : [{ kind: exception.kind, target: exception.target }];
    if (findings.length === 0) {
      errors.push(`${prefix} must name at least one exact finding.`);
    } else if (findings.length > 256) {
      errors.push(`${prefix} exceeds the 256-finding limit.`);
    }
    findings.forEach((finding, findingIndex) => {
      const findingPrefix = `${prefix} finding ${findingIndex}`;
      if (!['file', 'export'].includes(finding.kind)) {
        errors.push(`${findingPrefix} has an invalid kind.`);
      }
      if (!finding.target?.trim()) {
        errors.push(`${findingPrefix} requires a target.`);
      } else if (
        (finding.kind === 'export' && !finding.target.includes('#'))
        || (finding.kind === 'file' && finding.target.includes('#'))
      ) {
        errors.push(`${findingPrefix} target does not match its kind.`);
      }
      const key = `${finding.kind}:${finding.target}`;
      if (targets.has(key)) {
        errors.push(`${findingPrefix} duplicates ${finding.target}.`);
      }
      targets.add(key);
    });
  });
  return errors;
}

function exceptionFindings(
  exception: DeadCodeExceptionV1,
): DeadCodeFindingV1[] {
  return 'findings' in exception
    ? exception.findings
    : [{ kind: exception.kind, target: exception.target }];
}

export async function analyzeDeadCodeV1(input: {
  rootDir: string;
  config: DeadCodeConfigV1;
  manifest: DeadCodeManifestV1;
  today: string;
}): Promise<DeadCodeReportV1> {
  const rootDir = resolve(input.rootDir);
  const allFiles = await walk(rootDir);
  const sources = allFiles
    .filter((path) => matchesAny(slash(relative(rootDir, path)), input.config.sourcePatterns))
    .sort();
  const sourceSet = new Set(sources);
  const facts = new Map<string, ModuleFacts>();

  for (const path of sources) {
    const parsed = moduleFacts(await readFile(path, 'utf8'), path);
    const usedExportsByDependency = new Map<string, Set<string>>();
    const dependencies: string[] = [];
    for (const imported of parsed.imports) {
      const dependency = resolveDependency(path, imported.specifier, sourceSet);
      if (!dependency) continue;
      dependencies.push(dependency);
      const names = usedExportsByDependency.get(dependency) ?? new Set<string>();
      imported.names.forEach((name) => names.add(name));
      usedExportsByDependency.set(dependency, names);
    }
    facts.set(path, {
      dependencies: [...new Set(dependencies)].sort(),
      exports: parsed.facts.exports,
      usedExportsByDependency,
    });
  }

  const selectRoots = (patterns: readonly string[]): string[] => sources.filter(
    (path) => matchesAny(slash(relative(rootDir, path)), patterns),
  );
  const productionRoots = selectRoots(input.config.productionEntrypoints);
  const testRoots = selectRoots(input.config.testEntrypoints);
  const scriptRoots = selectRoots(input.config.scriptEntrypoints)
    .filter((path) => !testRoots.includes(path));
  const productionReach = reachable(productionRoots, facts);
  const testReach = reachable(testRoots, facts);
  const scriptReach = reachable(scriptRoots, facts);
  const allReach = new Set([
    ...productionReach,
    ...testReach,
    ...scriptReach,
  ]);

  const usedExports = new Map<string, Set<string>>();
  for (const module of facts.values()) {
    for (const [dependency, names] of module.usedExportsByDependency) {
      const used = usedExports.get(dependency) ?? new Set<string>();
      names.forEach((name) => used.add(name));
      usedExports.set(dependency, used);
    }
  }
  for (const root of [...productionRoots, ...testRoots, ...scriptRoots]) {
    usedExports.set(root, new Set(['*']));
  }

  const findings: DeadCodeFindingV1[] = [];
  for (const path of sources) {
    const relativePath = slash(relative(rootDir, path));
    if (!allReach.has(path)) {
      findings.push({ kind: 'file', target: relativePath });
      continue;
    }
    const used = usedExports.get(path) ?? new Set<string>();
    if (used.has('*')) continue;
    for (const exported of facts.get(path)?.exports ?? []) {
      if (!used.has(exported)) {
        findings.push({
          kind: 'export',
          target: `${relativePath}#${exported}`,
        });
      }
    }
  }
  findings.sort((left, right) =>
    `${left.kind}:${left.target}`.localeCompare(`${right.kind}:${right.target}`));

  const errors = manifestErrors(input.manifest, input.today);
  const exceptionByFinding = new Map<string, DeadCodeExceptionV1>();
  input.manifest.exceptions.forEach((exception) => {
    exceptionFindings(exception).forEach((finding) => {
      exceptionByFinding.set(`${finding.kind}:${finding.target}`, exception);
    });
  });
  const suppressed: DeadCodeReportV1['suppressed'] = [];
  const violations: DeadCodeFindingV1[] = [];
  for (const finding of findings) {
    const exception = exceptionByFinding.get(`${finding.kind}:${finding.target}`);
    if (exception) suppressed.push({ finding, exception });
    else violations.push(finding);
  }
  const findingKeys = new Set(
    findings.map((finding) => `${finding.kind}:${finding.target}`),
  );
  input.manifest.exceptions.forEach((exception) => {
    exceptionFindings(exception).forEach((finding) => {
      const key = `${finding.kind}:${finding.target}`;
      if (!findingKeys.has(key)) {
        errors.push(`Stale exception does not match a finding: ${finding.target}.`);
      }
    });
  });

  const relativeSorted = (paths: Iterable<string>): string[] =>
    [...paths].map((path) => slash(relative(rootDir, path))).sort();
  const testOnly = [...testReach].filter((path) =>
    !productionReach.has(path) && !scriptReach.has(path));
  const scriptOnly = [...scriptReach].filter((path) =>
    !productionReach.has(path) && !testReach.has(path));
  const sharedNonProduction = [...testReach].filter((path) =>
    !productionReach.has(path) && scriptReach.has(path));

  return {
    version: 1,
    entrypoints: {
      production: relativeSorted(productionRoots),
      test: relativeSorted(testRoots),
      script: relativeSorted(scriptRoots),
    },
    reachability: {
      production: relativeSorted(productionReach),
      testOnly: relativeSorted(testOnly),
      scriptOnly: relativeSorted(scriptOnly),
      sharedNonProduction: relativeSorted(sharedNonProduction),
    },
    findings,
    suppressed,
    violations,
    manifestErrors: errors.sort(),
  };
}

export async function readDeadCodeInputsV1(rootDir: string): Promise<{
  config: DeadCodeConfigV1;
  manifest: DeadCodeManifestV1;
}> {
  const config = JSON.parse(
    await readFile(join(rootDir, 'dead-code.config.json'), 'utf8'),
  ) as DeadCodeConfigV1;
  if (config.version !== 1) throw new Error('Dead-code config must be version 1.');
  const manifest = JSON.parse(
    await readFile(join(rootDir, config.exceptionManifest), 'utf8'),
  ) as DeadCodeManifestV1;
  return { config, manifest };
}
