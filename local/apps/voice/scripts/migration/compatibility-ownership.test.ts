import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  analyzeCompatibilityOwnershipV1,
  compatibilityOwnershipSurfacesV1,
  inspectCompatibilityOwnershipV1,
} from './compatibility-ownership';

describe('compatibility ownership migration gate', () => {
  it('inventories only the reviewed production compatibility surfaces', async () => {
    const rootDir = resolve(import.meta.dirname, '../..');
    const report = await inspectCompatibilityOwnershipV1(rootDir);

    expect(report.violations).toEqual([]);
    expect(report.inventory.filter(({ category }) =>
      category === 'v1_conversation_owner')
      .flatMap(({ occurrences }) => occurrences)).toEqual([]);
    expect(report.inventory.find(({ id }) =>
      id === 'v1_authoritative_task_repository')?.occurrences
      .filter(({ file }) =>
        file === 'app/api/device/selection/route.ts')).toEqual([]);
    expect(report.inventory.filter(({ id }) =>
      [
        'conversation_state_global',
        'conversation_state_writes',
        'v1_conversation_map_allocation',
      ].includes(id))
      .flatMap(({ occurrences }) => occurrences)).toEqual([]);
    expect(report.inventory.find(({ id }) =>
      id === 'v1_pending_checkout_state')?.occurrences
      .filter(({ file }) =>
        [
          'lib/workflow/recovery-coordinator.ts',
          'lib/workflow/recovery-persistence.ts',
        ].includes(file))).toEqual([]);
    expect(report.inventory.filter(({ category }) => category === 'dual_save')
      .flatMap(({ occurrences }) => occurrences)).toEqual([]);
    expect(report.inventory.filter(({ category }) =>
      category === 'legacy_checkout_alias')
      .flatMap(({ occurrences }) => occurrences)).toEqual([]);
    expect(report.inventory.filter(({ category }) =>
      category === 'legacy_checkout_alias')
      .flatMap(({ occurrences }) => occurrences)
      .filter(({ file }) => file === 'lib/voice-turn/coordinator.ts'))
      .toEqual([]);
  });

  it('fails when a new file takes V1 conversation ownership', () => {
    const report = analyzeCompatibilityOwnershipV1({
      sources: {
        'lib/new-conversation-owner.ts':
          'const errandosVoiceConversations = new Map();',
      },
    });

    expect(report.violations).toContainEqual({
      actual: 1,
      allowed: 0,
      file: 'lib/new-conversation-owner.ts',
      surfaceId: 'conversation_state_global',
      type: 'new_ownership_file',
    });
  });

  it('fails when the removed conversation writer is reintroduced', () => {
    const report = analyzeCompatibilityOwnershipV1({
      sources: {
        'lib/voice-turn/coordinator.ts':
          'saveConversationState();'.repeat(4),
      },
    });

    expect(report.violations).toContainEqual({
      actual: 4,
      allowed: 0,
      file: 'lib/voice-turn/coordinator.ts',
      surfaceId: 'conversation_state_writes',
      type: 'new_ownership_file',
    });
  });

  it('allows compatibility ownership to shrink during removal', () => {
    expect(analyzeCompatibilityOwnershipV1({ sources: {} }).violations)
      .toEqual([]);
  });

  it('requires explicit removal prerequisites for every surface', () => {
    for (const surface of compatibilityOwnershipSurfacesV1) {
      expect(surface.removalPrerequisites.length).toBeGreaterThan(0);
      expect(new Set(surface.removalPrerequisites.map(({ id }) => id)).size)
        .toBe(surface.removalPrerequisites.length);
    }
  });
});
