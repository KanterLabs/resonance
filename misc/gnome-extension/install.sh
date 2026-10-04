#!/usr/bin/env bash
# Install the Resonance GNOME Shell extension for the current user, or reload it
# if it is already installed. GNOME only discovers a brand new extension at
# login, so the first install on Wayland needs a log out and back in.
set -euo pipefail

uuid=resonance@kanterlabs.dev
source="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$uuid"
target="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"

mkdir -p "$target"
cp -r "$source"/. "$target"/
glib-compile-schemas "$target/schemas"

if gnome-extensions info "$uuid" >/dev/null 2>&1; then
    # Disable and enable so the shell imports the new modules (extension.js
    # versions them by mtime).
    gnome-extensions disable "$uuid" || true
    gnome-extensions enable "$uuid"
    echo "Reloaded $uuid. Press Super+M."
else
    echo "Installed $uuid. Log out and back in, then run:"
    echo "  gnome-extensions enable $uuid"
fi
