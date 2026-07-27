#!/usr/bin/env bash
set -euo pipefail

ANDROID_HOME=/opt/android-sdk
NODE_VERSION=v22.17.1
CMDLINE_TOOLS=14742923

if [[ "${ERRANDOS_ACCEPT_ANDROID_SDK_LICENSES:-false}" != "true" ]]; then
  echo "Android SDK licenses not accepted; set ERRANDOS_ACCEPT_ANDROID_SDK_LICENSES=true after owner confirmation" >&2
  exit 10
fi

sudo apt-get update
sudo apt-get install -y \
  curl unzip xz-utils openjdk-17-jre-headless qemu-kvm cpu-checker \
  libgl1 libpulse0 libxkbcommon0

id errandos >/dev/null 2>&1 || \
  sudo useradd --create-home --shell /bin/bash --groups kvm errandos
sudo usermod -aG kvm errandos

if [[ "$(/opt/node/bin/node --version 2>/dev/null || true)" != "$NODE_VERSION" ]]; then
  curl -fsSLO "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz"
  sudo rm -rf /opt/node
  sudo mkdir -p /opt/node
  sudo tar -xJf "node-$NODE_VERSION-linux-x64.tar.xz" -C /opt/node --strip-components=1
  rm "node-$NODE_VERSION-linux-x64.tar.xz"
fi

if [[ ! -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]]; then
  curl -fsSLO "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS}_latest.zip"
  sudo rm -rf "$ANDROID_HOME"
  sudo mkdir -p "$ANDROID_HOME/cmdline-tools/latest"
  tmp="$(mktemp -d)"
  unzip -q "commandlinetools-linux-${CMDLINE_TOOLS}_latest.zip" -d "$tmp"
  sudo cp -a "$tmp/cmdline-tools/." "$ANDROID_HOME/cmdline-tools/latest/"
  rm -rf "$tmp" "commandlinetools-linux-${CMDLINE_TOOLS}_latest.zip"
  sudo chown -R errandos:errandos "$ANDROID_HOME"
fi

sudo -u errandos env \
  HOME=/home/errandos \
  ANDROID_HOME="$ANDROID_HOME" \
  PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$PATH" \
  bash -c 'cd /tmp && yes | sdkmanager --licenses >/dev/null'

sudo -u errandos env \
  HOME=/home/errandos \
  ANDROID_HOME="$ANDROID_HOME" \
  PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$PATH" \
  bash -c "cd /tmp && sdkmanager \
    'platform-tools' \
    'emulator' \
    'system-images;android-35;google_apis_playstore;x86_64'"

sudo -u errandos env \
  HOME=/home/errandos \
  ANDROID_HOME="$ANDROID_HOME" \
  PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$PATH" \
  bash -c 'cd /tmp && printf "no\n" | avdmanager create avd --force --name errandos_pixel_api35 --package "system-images;android-35;google_apis_playstore;x86_64" --device pixel_8'

sudo rm -rf /opt/appium /opt/appium-home
sudo env PATH="/opt/node/bin:$PATH" \
  /opt/node/bin/npm install --global --prefix /opt/appium appium@3.5.2
sudo mkdir -p /opt/appium-home
sudo env \
  PATH="/opt/node/bin:$PATH" \
  APPIUM_HOME=/opt/appium-home \
  /opt/appium/bin/appium driver install uiautomator2@8.1.0
sudo chown -R errandos:errandos /opt/appium /opt/appium-home

sudo install -o root -g root -m 0644 \
  systemd/errandos-emulator.service /etc/systemd/system/errandos-emulator.service
sudo install -o root -g root -m 0644 \
  systemd/errandos-appium.service /etc/systemd/system/errandos-appium.service
sudo systemctl daemon-reload
sudo systemctl enable --now errandos-emulator.service
sudo systemctl enable --now errandos-appium.service
