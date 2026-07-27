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

"${JAVAC_TASK}" \
  -source 8 \
  -target 8 \
  -bootclasspath "${ANDROID_JAR_TASK}" \
  -d "${BUILD_TMP_TASK}/classes" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/MainActivity.java" \
  "${SCRIPT_DIR}/src/ai/errandos/overlay/OverlayService.java"

"${JAR_TASK}" cf "${BUILD_TMP_TASK}/classes.jar" -C "${BUILD_TMP_TASK}/classes" .
"${BUILD_TOOLS_TASK}/d8" \
  --lib "${ANDROID_JAR_TASK}" \
  --output "${BUILD_TMP_TASK}/dex" \
  "${BUILD_TMP_TASK}/classes.jar"

"${BUILD_TOOLS_TASK}/aapt2" link \
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
