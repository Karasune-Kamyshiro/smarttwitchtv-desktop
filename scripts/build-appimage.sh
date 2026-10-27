#!/usr/bin/env bash
# Build SmartTwitchTV-x86_64.AppImage.
# Needs: git, node ≥ 18 + npm, curl. Used by CI, works locally too.
set -euo pipefail
cd "$(dirname "$0")/.."

ARCH=x86_64
OUT="${1:-SmartTwitchTV-$ARCH.AppImage}"

# 1. upstream web app (fresh shallow clone unless one is already there)
if [ ! -e upstream ]; then
    git clone --depth 1 https://github.com/fgl27/SmartTwitchTV.git upstream
fi

# 2. dependencies + Electron binary (Electron ≥ 40 has no postinstall hook)
npm ci --no-audit --no-fund
node node_modules/electron/install.js

# 3. web app + app tree
node scripts/prepare-web.mjs upstream
APPDIR=dist/AppDir
rm -rf "$APPDIR"
node scripts/assemble.mjs "$APPDIR/smarttwitchtv"
# The setuid sandbox helper can't work from a read-only AppImage mount.
rm -f "$APPDIR/smarttwitchtv/chrome-sandbox"

cat >"$APPDIR/AppRun" <<'EOF'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
# Chromium's setuid sandbox is unavailable inside an AppImage (same as electron-builder AppImages).
exec "$HERE/smarttwitchtv/smarttwitchtv" --no-sandbox "$@"
EOF
chmod +x "$APPDIR/AppRun"

sed -e 's/^Icon=.*/Icon=smarttwitchtv/' -e 's/^Exec=smarttwitchtv %U/Exec=AppRun %U/' -e 's/^Exec=smarttwitchtv --windowed/Exec=AppRun --windowed/' \
    packaging/flatpak/io.github.smarttwitchtv.Desktop.desktop >"$APPDIR/smarttwitchtv.desktop"
cp build/icon-256.png "$APPDIR/smarttwitchtv.png"
cp build/icon-256.png "$APPDIR/.DirIcon"
mkdir -p "$APPDIR/usr/share/metainfo"
sed 's#<launchable type="desktop-id">.*</launchable>#<launchable type="desktop-id">smarttwitchtv.desktop</launchable>#' \
    packaging/flatpak/io.github.smarttwitchtv.Desktop.metainfo.xml >"$APPDIR/usr/share/metainfo/smarttwitchtv.appdata.xml"

# 4. pack
TOOL=dist/appimagetool
if [ ! -x "$TOOL" ]; then
    curl -fsSL -o "$TOOL" "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-$ARCH.AppImage"
    chmod +x "$TOOL"
fi
APPIMAGE_EXTRACT_AND_RUN=1 ARCH=$ARCH "$TOOL" --no-appstream "$APPDIR" "$OUT"
echo "built $OUT"
