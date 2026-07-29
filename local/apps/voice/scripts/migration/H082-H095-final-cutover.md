# H082/H095 final workflow cutover

Workflow V2 is now a release invariant. `JALDI_PHONE_TASK_V2` and
`JALDI_AUTHORITATIVE_TASK_STATE_V1` are no longer runtime engine selectors.
Rollback means deploying the previous release.

## Live deletion blockers

Workflow ownership, dual-save counts, and H083 compatibility command aliases
are zero. Persisted runtime records use canonical V2 action names.

| Owner | Current surface | Current occurrences | Replacement required |
| --- | --- | ---: | --- |
| Legacy final-dispatch alias | 0 | Removed; canonical `confirm_checkout` is the only command. |
| Legacy checkout-preparation alias | 0 | Removed; canonical `prepare_checkout` is the only command. |
| Legacy grocery-preparation alias | 0 | Removed; canonical `add_cart_item` is the only command. |

## Final atomic deletion order

1. Migrate the device-selection endpoint and product-selection presentation to
   the revision-bound V2 pending interaction. **Completed:** the device route,
   presentation wire contract, and native overlay submit revision-bound V2
   `product_choice` metadata; the ownership allowance is zero.
2. Constant-fold coordinator workflow selection to V2 and remove the
   `phoneTaskV2` false branches. **Completed.**
3. Replace remaining V1 pending-choice, queue, cancellation, checkout, and
   terminal reads/writes with native V2 transitions. **Completed.**
4. Delete the four coordinator calls to
   `synchronizeLocalTaskProjectionV2`, then delete the runtime projection
   entrypoint and `compatibility.ts`. **Completed.**
5. Delete `authoritativeTaskRepository`, V1 task state/transitions, and the V1
   product-selection consumer only after production imports reach zero.
   **Completed after the production import scan reached zero.**
6. Set every affected ownership-gate allowance to zero and run the full voice
   test suite, ownership report, dead-code check, and strict TypeScript check.
   **Completed:** ownership allowances are zero; final suite/type/dead-code
   validation is recorded by the release coordinator.

## Already removed

- Global in-route conversation map and checkpoint writer.
- V1 checkout recovery serialization and rehydration.
- Entire unreferenced V1 recovery coordinator/persistence stack.
- Runtime environment switches for V1/V2 engine selection.
- Device product-choice submission ownership by the V1 task repository and
  in-memory clarification resolver.
- V1 product-selection resolver/consumer and their standalone tests; the H090
  card/voice race matrix now uses the V2 repository revision boundary.
- Product-selection presentation dependency on V1 task state,
  `pendingClarification`, and the atomic-selection runtime flag.
- V1 task repository, state, transitions, product-task helper, and pure
  V1-to-V2 projection modules.
- `commitCompatibilityProjection` from both V2 repository implementations.
