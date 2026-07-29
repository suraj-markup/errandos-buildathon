import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

export type CompatibilityOwnershipCategoryV1 =
  | 'dual_save'
  | 'legacy_checkout_alias'
  | 'v1_conversation_owner';

export type CompatibilityRemovalPrerequisiteV1 = {
  id: string;
  requirement: string;
};

export type CompatibilityOwnershipOccurrenceV1 = {
  column: number;
  file: string;
  line: number;
  match: string;
};

export type CompatibilityOwnershipSurfaceV1 = {
  allowedOccurrences: Readonly<Record<string, number>>;
  category: CompatibilityOwnershipCategoryV1;
  id: string;
  pattern: RegExp;
  removalPrerequisites: readonly CompatibilityRemovalPrerequisiteV1[];
};

export type CompatibilityOwnershipInventoryEntryV1 = {
  category: CompatibilityOwnershipCategoryV1;
  id: string;
  occurrences: readonly CompatibilityOwnershipOccurrenceV1[];
  removalPrerequisites: readonly CompatibilityRemovalPrerequisiteV1[];
};

export type CompatibilityOwnershipViolationV1 = {
  actual: number;
  allowed: number;
  file: string;
  surfaceId: string;
  type: 'new_ownership_file' | 'occurrence_limit_exceeded';
};

export type CompatibilityOwnershipReportV1 = {
  inventory: readonly CompatibilityOwnershipInventoryEntryV1[];
  violations: readonly CompatibilityOwnershipViolationV1[];
};

const conversationPrerequisites = [
  {
    id: 'v2_conversation_state_owner',
    requirement:
      'PhoneTaskV2 must own pending interactions, response continuity, language, cancellation, and terminal state without the conversation map.',
  },
  {
    id: 'v2_retained_progress_owner',
    requirement:
      'Retained V2 task events must restore Android progress and pending choices without rebuilding ConversationState.',
  },
  {
    id: 'v1_recovery_retired',
    requirement:
      'V1 task recovery and pendingCheckout rehydration must be removed or migrated to native V2 records.',
  },
] as const;

const dualSavePrerequisites = [
  {
    id: 'native_v2_commits_only',
    requirement:
      'Every production task creation, transition, cancellation, and terminal update must commit directly to PhoneTaskV2.',
  },
  {
    id: 'compatibility_projection_unused',
    requirement:
      'No production call may invoke synchronizeLocalTaskProjectionV2 or commitCompatibilityProjection.',
  },
  {
    id: 'v2_restart_canary',
    requirement:
      'Restart recovery and mutation reconciliation canaries must pass using only the V2 repository.',
  },
] as const;

const aliasPrerequisites = [
  {
    id: 'canonical_planner_tools',
    requirement:
      'Planner and coordinator tool declarations must emit prepare_checkout and confirm_checkout only.',
  },
  {
    id: 'canonical_realtime_tools',
    requirement:
      'Realtime schemas, shadow corpora, recovery records, and phone execution must use canonical V2 command names.',
  },
  {
    id: 'zero_v1_protocol_callers',
    requirement:
      'Telemetry or an equivalent caller inventory must show zero negotiated or unversioned V1 phone-command clients.',
  },
] as const;

export const compatibilityOwnershipSurfacesV1:
readonly CompatibilityOwnershipSurfaceV1[] = [
  {
    id: 'conversation_state_global',
    category: 'v1_conversation_owner',
    pattern: /\berrandosVoiceConversations\b/g,
    allowedOccurrences: {},
    removalPrerequisites: conversationPrerequisites,
  },
  {
    id: 'conversation_state_writes',
    category: 'v1_conversation_owner',
    pattern: /\bsaveConversationState\b/g,
    allowedOccurrences: {},
    removalPrerequisites: conversationPrerequisites,
  },
  {
    id: 'v1_authoritative_task_repository',
    category: 'v1_conversation_owner',
    pattern: /\bauthoritativeTaskRepository\b/g,
    allowedOccurrences: {},
    removalPrerequisites: conversationPrerequisites,
  },
  {
    id: 'v1_conversation_map_allocation',
    category: 'v1_conversation_owner',
    pattern: /new Map<string,\s*ConversationState>\(\)/g,
    allowedOccurrences: {},
    removalPrerequisites: conversationPrerequisites,
  },
  {
    id: 'v1_task_map_allocation',
    category: 'v1_conversation_owner',
    pattern:
      /new Map<LocalIdentifier<'task'>,\s*LocalPhoneTaskV1>\(\)/g,
    allowedOccurrences: {},
    removalPrerequisites: conversationPrerequisites,
  },
  {
    id: 'v1_pending_checkout_state',
    category: 'v1_conversation_owner',
    pattern: /\bpendingCheckout\b/g,
    allowedOccurrences: {},
    removalPrerequisites: conversationPrerequisites,
  },
  {
    id: 'v1_to_v2_projection_entrypoint',
    category: 'dual_save',
    pattern: /\bsynchronizeLocalTaskProjectionV2\b/g,
    allowedOccurrences: {},
    removalPrerequisites: dualSavePrerequisites,
  },
  {
    id: 'v2_compatibility_repository_commit',
    category: 'dual_save',
    pattern: /\bcommitCompatibilityProjection\b/g,
    allowedOccurrences: {},
    removalPrerequisites: dualSavePrerequisites,
  },
  {
    id: 'v1_task_projection',
    category: 'dual_save',
    pattern: /\bprojectLocalPhoneTaskV1ToV2\b/g,
    allowedOccurrences: {},
    removalPrerequisites: dualSavePrerequisites,
  },
  {
    id: 'legacy_confirm_cod_order',
    category: 'legacy_checkout_alias',
    pattern: /\bconfirm_cod_order\b/g,
    allowedOccurrences: {},
    removalPrerequisites: aliasPrerequisites,
  },
  {
    id: 'legacy_prepare_cod_checkout',
    category: 'legacy_checkout_alias',
    pattern: /\bprepare_cod_checkout\b/g,
    allowedOccurrences: {},
    removalPrerequisites: aliasPrerequisites,
  },
  {
    id: 'legacy_prepare_grocery',
    category: 'legacy_checkout_alias',
    pattern: /\bprepare_grocery\b/g,
    allowedOccurrences: {},
    removalPrerequisites: aliasPrerequisites,
  },
] as const;

function occurrence(
  file: string,
  source: string,
  match: RegExpExecArray,
): CompatibilityOwnershipOccurrenceV1 {
  const before = source.slice(0, match.index);
  const lines = before.split('\n');
  return {
    file,
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
    match: match[0],
  };
}

export function analyzeCompatibilityOwnershipV1(input: {
  sources: Readonly<Record<string, string>>;
  surfaces?: readonly CompatibilityOwnershipSurfaceV1[];
}): CompatibilityOwnershipReportV1 {
  const surfaces = input.surfaces ?? compatibilityOwnershipSurfacesV1;
  const violations: CompatibilityOwnershipViolationV1[] = [];
  const inventory = surfaces.map((surface) => {
    const occurrences = Object.entries(input.sources)
      .flatMap(([file, source]) => {
        const pattern = new RegExp(surface.pattern.source, 'g');
        return [...source.matchAll(pattern)].map((match) =>
          occurrence(file, source, match));
      })
      .sort((left, right) =>
        left.file.localeCompare(right.file)
        || left.line - right.line
        || left.column - right.column);
    const byFile = new Map<string, number>();
    occurrences.forEach(({ file }) => {
      byFile.set(file, (byFile.get(file) ?? 0) + 1);
    });
    byFile.forEach((actual, file) => {
      const allowed = surface.allowedOccurrences[file] ?? 0;
      if (allowed === 0) {
        violations.push({
          actual,
          allowed,
          file,
          surfaceId: surface.id,
          type: 'new_ownership_file',
        });
      } else if (actual > allowed) {
        violations.push({
          actual,
          allowed,
          file,
          surfaceId: surface.id,
          type: 'occurrence_limit_exceeded',
        });
      }
    });
    return {
      category: surface.category,
      id: surface.id,
      occurrences,
      removalPrerequisites: surface.removalPrerequisites,
    };
  });
  return {
    inventory,
    violations: violations.sort((left, right) =>
      left.surfaceId.localeCompare(right.surfaceId)
      || left.file.localeCompare(right.file)),
  };
}

async function productionTypeScriptFiles(rootDir: string): Promise<string[]> {
  const productionRoots = ['app', 'lib'].map((directory) =>
    resolve(rootDir, directory));
  const files = await Promise.all(productionRoots.map(async (directory) => {
    const entries = await readdir(directory, {
      recursive: true,
      withFileTypes: true,
    });
    return entries
      .filter((entry) =>
        entry.isFile()
        && entry.name.endsWith('.ts')
        && !entry.name.endsWith('.test.ts'))
      .map((entry) => resolve(entry.parentPath, entry.name));
  }));
  return files
    .flat()
    .sort();
}

export async function readCompatibilityOwnershipSourcesV1(
  rootDir: string,
): Promise<Record<string, string>> {
  const files = await productionTypeScriptFiles(rootDir);
  return Object.fromEntries(await Promise.all(files.map(async (file) => [
    relative(rootDir, file),
    await readFile(file, 'utf8'),
  ])));
}

export async function inspectCompatibilityOwnershipV1(
  rootDir: string,
): Promise<CompatibilityOwnershipReportV1> {
  return analyzeCompatibilityOwnershipV1({
    sources: await readCompatibilityOwnershipSourcesV1(rootDir),
  });
}
