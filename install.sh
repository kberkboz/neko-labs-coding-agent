#!/usr/bin/env bash
# Neko Labs Coding Agent installer (macOS / Linux).
# Run from the cloned repo:  bash install.sh
set -euo pipefail

echo "Installing Neko Labs Coding Agent..."

# 1. Ensure Bun.
if ! command -v bun >/dev/null 2>&1; then
  echo "Bun not found. Installing Bun from bun.sh..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi
if ! command -v bun >/dev/null 2>&1; then
  echo "Could not find Bun after install. Install it from https://bun.sh and re-run." >&2
  exit 1
fi

# 2. Repo = the directory this script lives in.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO"

# 3. Dependencies (builds native modules; needs a C/C++ toolchain).
echo "Installing dependencies (this can take a few minutes)..."
bun install

# 4. Install the 'neko' launcher.
BIN="$HOME/.local/bin"
mkdir -p "$BIN"
LAUNCHER="$BIN/neko"
cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
# Neko Labs Coding Agent launcher
NEKO_PKG="$REPO/packages/opencode"
if [ \$# -eq 0 ]; then
  exec bun run --cwd "\$NEKO_PKG" --conditions=browser src/index.ts "\$(pwd)"
else
  exec bun run --cwd "\$NEKO_PKG" --conditions=browser src/index.ts "\$@"
fi
EOF
chmod +x "$LAUNCHER"

echo ""
echo "Installed: $LAUNCHER"
case ":$PATH:" in
  *":$BIN:"*) echo "Done. Run 'neko' in any project." ;;
  *)
    echo "Add $BIN to your PATH, then run 'neko'. For example:"
    echo "  echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.zshrc && source ~/.zshrc"
    ;;
esac
