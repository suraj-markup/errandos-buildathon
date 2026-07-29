type SharedCartInspectionEvidenceV2 = {
  ordinaryPostMutationInspections: 0 | 1;
  inspection?: unknown;
};

const evidenceByResult = new WeakMap<object, SharedCartInspectionEvidenceV2>();

export function attachSharedCartInspectionEvidenceV2<Result extends object>(
  result: Result,
  evidence: SharedCartInspectionEvidenceV2,
): Result {
  evidenceByResult.set(result, evidence);
  return result;
}

export function sharedCartInspectionEvidenceV2(
  result: unknown,
): SharedCartInspectionEvidenceV2 | undefined {
  return result !== null && typeof result === 'object'
    ? evidenceByResult.get(result)
    : undefined;
}
