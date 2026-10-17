#!/bin/sh
# Tauri's generated .desktop entry lacks "%f" in Exec, so "Open With →
# MarkDawn" launches the app without the file. Patch the data archive inside
# the built deb — and recompute control/md5sums, which a data-only repack
# leaves stale (dpkg --verify would fail on every installed machine).
# Run after `tauri build --bundles deb`.
set -eu
cd "$(dirname "$0")/.."

version=$(node -p "require('./package.json').version")
deb="src-tauri/target/release/bundle/deb/MarkDawn_${version}_amd64.deb"
[ -f "$deb" ] || { echo "deb not found: $deb (build it first)"; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
ar x "$deb" --output="$work"
tar -xzf "$work/data.tar.gz" -C "$work"

desktop="$work/usr/share/applications/MarkDawn.desktop"
if grep -q '^Exec=markdawn %f' "$desktop"; then
  echo "desktop entry already patched"
  exit 0
fi
sed -i 's|^Exec=markdawn$|Exec=markdawn %f|' "$desktop"

tar -czf "$work/data.tar.gz" -C "$work" usr

# Refresh md5sums for the file we just changed, then repack control.
md5sums="$work/DEBIAN/md5sums"
if [ -f "$md5sums" ]; then
  new=$(md5sum "$desktop" | cut -d' ' -f1)
  sed -i "s|^[0-9a-f]*  usr/share/applications/MarkDawn.desktop|$new  usr/share/applications/MarkDawn.desktop|" "$md5sums"
  tar -czf "$work/control.tar.gz" -C "$work" DEBIAN
fi

# `ar r` replaces members in place, keeping debian-binary first (required).
ar r "$deb" \
  "$work/debian-binary" \
  "$work/control.tar.gz" \
  "$work/data.tar.gz"
echo "patched: $deb ($(grep '^Exec=' "$desktop"))"
