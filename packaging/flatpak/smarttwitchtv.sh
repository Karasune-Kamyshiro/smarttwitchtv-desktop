#!/bin/sh
# Launcher inside the Flatpak.
# Electron needs a writable TMPDIR it can share between its processes.
export TMPDIR="${XDG_RUNTIME_DIR}/app/${FLATPAK_ID}"

# X11 (XWayland) by default: works in desktop sessions and in Steam's Gaming Mode (gamescope).
# Run with STV_WAYLAND=1 to use native Wayland instead.
if [ -n "$STV_WAYLAND" ]; then
    PLATFORM="--ozone-platform=wayland --enable-wayland-ime"
else
    PLATFORM="--ozone-platform=x11"
fi

exec zypak-wrapper /app/smarttwitchtv/smarttwitchtv $PLATFORM "$@"
