#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
ANDROID_SDK_TASK="/Users/suraj/Library/Android/sdk"
BUILD_TOOLS_TASK="${ANDROID_SDK_TASK}/build-tools/36.0.0"
ANDROID_JAR_TASK="${ANDROID_SDK_TASK}/platforms/android-36/android.jar"
JAVAC_TASK="/opt/homebrew/opt/openjdk@17/bin/javac"
JAR_TASK="/opt/homebrew/opt/openjdk@17/bin/jar"
DEBUG_KEYSTORE_TASK="/Users/suraj/.android/debug.keystore"
BUILD_TMP_TASK="$(mktemp -d)"
export JAVA_HOME="/opt/homebrew/opt/openjdk@17"
export PATH="${JAVA_HOME}/bin:${PATH}"

mkdir -p "${SCRIPT_DIR}/dist"
mkdir -p "${BUILD_TMP_TASK}/classes" "${BUILD_TMP_TASK}/dex"
mkdir -p "${BUILD_TMP_TASK}/test-classes"

"${JAVAC_TASK}" \
  -source 8 \
  -target 8 \
  -d "${BUILD_TMP_TASK}/test-classes" \
  "${SCRIPT_DIR}/test-support/android/util/Log.java" \
  "${SCRIPT_DIR}/test-support/org/json/JSONParser.java" \
  "${SCRIPT_DIR}/test-support/org/json/JSONObject.java" \
  "${SCRIPT_DIR}/test-support/org/json/JSONArray.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/OverlayPresentation.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/OverlayPresentationParser.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/OverlayRecoverySnapshot.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/MotionPolicy.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/OverlayLifecyclePolicy.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/ProductSelectionState.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/ProductSelectionResponse.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/CompletionChoiceState.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/RecoveryActionBinding.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/RecoveryActionPolicy.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/RecoveryActionState.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/RecoveryActionResponse.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/DeferredSynthesisState.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/FinalCartActionPolicy.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/QueueTaskProjection.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/QueueActionPolicy.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/QueueCommandState.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/SemanticProgressState.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/TaskEventSubscriptionState.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/StatusIngressCapability.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/StatusIngressPolicy.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/AtomicPersistenceGate.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/TaskProjectionDurability.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/CompanionIssueV2.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/RetainedTaskEvent.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/RetainedTaskEventParser.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/TaskEventPresentationFactory.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/TaskChecklistState.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/DeterministicCompanionCopy.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/InteractionFeedbackPolicy.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/InteractionLatencyTracker.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/ProductSelectionStateTest.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/ProductSelectionResponseTest.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/CompletionChoiceStateTest.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/RecoveryActionStateTest.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/RecoveryActionResponseTest.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/DeferredSynthesisStateTest.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/FinalCartActionPolicyTest.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/QueueControlsTest.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/QueueControlsSourceContractTest.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/OverlayRecoverySnapshotTest.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/MotionPolicyTest.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/OverlayLifecyclePolicyTest.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/OverlayTaskProgressTest.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/SemanticProgressStateTest.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/TaskEventSubscriptionStateTest.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/TaskEventPresentationFactoryTest.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/TaskChecklistStateTest.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/DeterministicCompanionCopyTest.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/InteractionFeedbackPolicyTest.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/InteractionLatencyTrackerTest.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/ProductionParserFixtureTest.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/MultiItemCompanionFixtureContractTest.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/MultiItemNativePolicyContractTest.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/NativeSourceContractTest.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/StatusIngressCapabilityTest.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/StatusIngressPolicyTest.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/AtomicPersistenceGateTest.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/TaskProjectionDurabilityTest.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/CompanionIssueV2Test.java" \
  "${SCRIPT_DIR}/test/ai/errandos/overlay/AndroidSafetySourceContractTest.java"

"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.ProductSelectionStateTest
"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.ProductSelectionResponseTest \
  "${SCRIPT_DIR}/fixtures/product-selection-responses.json"
"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.CompletionChoiceStateTest
"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.RecoveryActionStateTest
"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.RecoveryActionResponseTest \
  "${SCRIPT_DIR}/fixtures/recovery-action-responses.json"
"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.DeferredSynthesisStateTest
"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.FinalCartActionPolicyTest
"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.QueueControlsTest \
  "${SCRIPT_DIR}/fixtures/queue-controls-task-v2.json"
"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.QueueControlsSourceContractTest \
  "${SCRIPT_DIR}/src/ai/errandos/overlay"
"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.OverlayRecoverySnapshotTest
"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.MotionPolicyTest
"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.OverlayLifecyclePolicyTest
"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.OverlayTaskProgressTest
"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.SemanticProgressStateTest
"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.TaskEventSubscriptionStateTest
"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.TaskEventPresentationFactoryTest
"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.TaskChecklistStateTest
"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.DeterministicCompanionCopyTest
"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.InteractionFeedbackPolicyTest
"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.InteractionLatencyTrackerTest
"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.ProductionParserFixtureTest \
  "${SCRIPT_DIR}/fixtures"
"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.MultiItemCompanionFixtureContractTest \
  "${SCRIPT_DIR}/fixtures"
"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.MultiItemNativePolicyContractTest \
  "${SCRIPT_DIR}/src/ai/errandos/overlay"
"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.NativeSourceContractTest \
  "${SCRIPT_DIR}/src/ai/errandos/overlay"
"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.StatusIngressCapabilityTest
"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.StatusIngressPolicyTest
"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.AtomicPersistenceGateTest
"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.TaskProjectionDurabilityTest \
  "${SCRIPT_DIR}/fixtures/retention-reset-recovery.json"
"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.CompanionIssueV2Test \
  "${SCRIPT_DIR}/fixtures/companion-issues-v2.json"
"${JAVA_HOME}/bin/java" \
  -cp "${BUILD_TMP_TASK}/test-classes" \
  ai.errandos.overlay.AndroidSafetySourceContractTest \
  "${SCRIPT_DIR}"

"${JAVAC_TASK}" \
  -source 8 \
  -target 8 \
  -bootclasspath "${ANDROID_JAR_TASK}" \
  -d "${BUILD_TMP_TASK}/classes" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/MainActivity.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/OverlayPresentation.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/OverlayPresentationParser.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/OverlayRecoverySnapshot.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/MotionPolicy.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/OverlayLifecyclePolicy.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/ProductSelectionState.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/ProductSelectionResponse.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/CompletionChoiceState.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/RecoveryActionBinding.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/RecoveryActionPolicy.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/RecoveryActionState.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/RecoveryActionResponse.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/DeferredSynthesisState.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/FinalCartActionPolicy.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/QueueTaskProjection.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/QueueActionPolicy.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/QueueCommandState.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/SemanticProgressState.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/TaskEventSubscriptionState.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/StatusIngressCapability.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/StatusIngressPolicy.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/AtomicPersistenceGate.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/TaskProjectionDurability.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/CompanionIssueV2.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/RetainedTaskEvent.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/RetainedTaskEventParser.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/TaskEventPresentationFactory.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/TaskChecklistState.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/DeterministicCompanionCopy.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/InteractionFeedbackPolicy.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/InteractionLatencyTracker.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/CompanionGlyphView.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/OverlayCardView.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/SpatialAttentionCommand.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/SpatialAttentionView.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/OverlayService.java"

"${JAR_TASK}" cf "${BUILD_TMP_TASK}/classes.jar" -C "${BUILD_TMP_TASK}/classes" .
"${BUILD_TOOLS_TASK}/d8" \
  --lib "${ANDROID_JAR_TASK}" \
  --output "${BUILD_TMP_TASK}/dex" \
  "${BUILD_TMP_TASK}/classes.jar"

"${BUILD_TOOLS_TASK}/aapt2" link \
  --debug-mode \
  -o "${BUILD_TMP_TASK}/unsigned.apk" \
  -I "${ANDROID_JAR_TASK}" \
  --manifest "${SCRIPT_DIR}/AndroidManifest.xml" \
  --min-sdk-version 26 \
  --target-sdk-version 36

(
  cd "${BUILD_TMP_TASK}/dex"
  zip -q "${BUILD_TMP_TASK}/unsigned.apk" classes.dex
)

"${BUILD_TOOLS_TASK}/zipalign" -f 4 \
  "${BUILD_TMP_TASK}/unsigned.apk" \
  "${BUILD_TMP_TASK}/aligned.apk"

"${BUILD_TOOLS_TASK}/apksigner" sign \
  --ks "${DEBUG_KEYSTORE_TASK}" \
  --ks-pass pass:android \
  --out "${SCRIPT_DIR}/dist/errandos-overlay-debug.apk" \
  "${BUILD_TMP_TASK}/aligned.apk"

"${BUILD_TOOLS_TASK}/apksigner" verify \
  "${SCRIPT_DIR}/dist/errandos-overlay-debug.apk"

echo "${SCRIPT_DIR}/dist/errandos-overlay-debug.apk"
