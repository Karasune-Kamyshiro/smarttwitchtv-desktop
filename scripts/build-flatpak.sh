#!/usr/bin/env bash
# Build and install SmartTwitchTV Desktop as a Flatpak for the current user.
#
#   ./scripts/build-flatpak.sh            build + install
#   ./scripts/build-flatpak.sh --bundle   also write SmartTwitchTV.flatpak (to copy to another PC)
#
# Re-run it any time to update: it pulls the latest SmartTwitchTV web app on every build.
set -euo pipefail

cd "$(dirname "$0")/.."
APP_ID=io.github.smarttwitchtv.Desktop
MANIFEST=packaging/flatpak/$APP_ID.yml

# flatpak-builder from the host, or the Flatpak-packaged one (works on SteamOS too).
if command -v flatpak-builder >/dev/null 2>&1; then
    BUILDER=(flatpak-builder)
else
    if ! flatpak info org.flatpak.Builder >/dev/null 2>&1; then
        echo "==> Installing flatpak-builder (org.flatpak.Builder) from Flathub"
        flatpak install --user -y flathub org.flatpak.Builder
    fi
    BUILDER=(flatpak run org.flatpak.Builder)
fi

flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo

echo "==> Building $APP_ID"
"${BUILDER[@]}" --user --install-deps-from=flathub --force-clean --install \
    --repo=repo build-dir "$MANIFEST"

if [ "${1:-}" = "--bundle" ]; then
    echo "==> Writing SmartTwitchTV.flatpak"
    flatpak build-bundle --runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo \
        repo SmartTwitchTV.flatpak "$APP_ID"
fi

echo
echo "Done. Start it from your app menu, or run:  flatpak run $APP_ID"
echo "Steam: Add a Game → Add a Non-Steam Game → SmartTwitchTV."
