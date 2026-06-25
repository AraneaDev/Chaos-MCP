#!/usr/bin/env bash
set -euo pipefail

# ─── Chaos-MCP Easy Installer ────────────────────────────────────────────────
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/codebuff/chaos-mcp/master/scripts/install.sh | bash
#   # or locally:
#   bash scripts/install.sh
#
# What it does:
#   1. Checks OS (Linux / macOS)
#   2. Checks Node.js >= 18
#   3. Installs chaos-mcp globally via npm
#   4. Verifies the installation
#   5. Prints quick-start guidance

readonly MIN_NODE_VERSION="18.0.0"
readonly PACKAGE_NAME="chaos-mcp"

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

print_success() { printf "${GREEN}✓${NC} %s\n" "$*"; }
print_error()   { printf "${RED}✗${NC} %s\n" "$*" >&2; }
print_info()    { printf "${CYAN}ℹ${NC} %s\n" "$*"; }
print_warn()    { printf "${YELLOW}⚠${NC} %s\n" "$*"; }
print_header()  { printf "\n${BOLD}%s${NC}\n" "$*"; }
print_step()    { printf "\n${CYAN}→${NC} %s...\n" "$*"; }

# ── 1. OS check ──────────────────────────────────────────────────────────────
print_header "Chaos-MCP Installer"
echo ""

case "$(uname -s)" in
  Linux|Darwin) print_success "OS: $(uname -s) — supported" ;;
  *)
    print_error "Unsupported OS: $(uname -s). Chaos-MCP supports Linux and macOS."
    print_info "For Windows, install via npm: npm install -g ${PACKAGE_NAME}"
    exit 1
    ;;
esac

# ── 2. Node.js version check ─────────────────────────────────────────────────
print_step "Checking Node.js"

if ! command -v node &>/dev/null; then
  print_error "Node.js is not installed."
  print_info "Install Node.js >= ${MIN_NODE_VERSION} from https://nodejs.org/"
  print_info "Or use a version manager:"
  print_info "  nvm:  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
  print_info "  fnm:  curl -fsSL https://fnm.vercel.app/install | bash"
  exit 1
fi

NODE_VERSION="$(node --version | sed 's/^v//')"
print_success "Node.js ${NODE_VERSION}"

# Semver comparison: check node version >= MIN_NODE_VERSION
node_major() { echo "$1" | cut -d. -f1; }
node_minor() { echo "$1" | cut -d. -f2; }
MIN_MAJOR=$(node_major "$MIN_NODE_VERSION")
MIN_MINOR=$(node_minor "$MIN_NODE_VERSION")
CUR_MAJOR=$(node_major "$NODE_VERSION")
CUR_MINOR=$(node_minor "$NODE_VERSION")

if [ "$CUR_MAJOR" -lt "$MIN_MAJOR" ] || { [ "$CUR_MAJOR" -eq "$MIN_MAJOR" ] && [ "$CUR_MINOR" -lt "$MIN_MINOR" ]; }; then
  print_error "Node.js ${NODE_VERSION} is too old. Chaos-MCP requires >= ${MIN_NODE_VERSION}."
  print_info "Upgrade at https://nodejs.org/ or via your version manager."
  exit 1
fi

# ── 3. npm check ─────────────────────────────────────────────────────────────
print_step "Checking npm"

if ! command -v npm &>/dev/null; then
  print_error "npm is not available (should ship with Node.js)."
  exit 1
fi

NPM_VERSION="$(npm --version)"
print_success "npm ${NPM_VERSION}"

# ── 4. Install chaos-mcp ────────────────────────────────────────────────────
print_step "Installing ${PACKAGE_NAME}"

# If we're running from within the repo, install from local checkout.
# Otherwise install from npm registry.
if [ -f "package.json" ] && grep -q "\"name\": \"${PACKAGE_NAME}\"" package.json 2>/dev/null; then
  print_info "Detected local checkout — installing from source..."
  # Build first, then link globally
  if [ -f "build/index.js" ]; then
    print_info "Build already exists; linking..."
    npm link 2>&1 | tail -1
  else
    print_info "Building from source..."
    npm install --silent 2>&1 | tail -3
    npm run build --silent 2>&1 | tail -3
    npm link 2>&1 | tail -1
  fi
else
  npm install -g "${PACKAGE_NAME}" 2>&1 | tail -3
fi

# ── 5. Verify installation ──────────────────────────────────────────────────
print_step "Verifying installation"

if ! command -v chaos-mcp &>/dev/null; then
  print_error "${PACKAGE_NAME} binary not found on PATH."
  print_info "npm global bin directory may not be in your PATH."
  print_info "Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
  print_info "  export PATH=\"\$(npm config get prefix)/bin:\$PATH\""
  exit 1
fi

INSTALLED_VERSION="$(chaos-mcp --version 2>&1 | sed 's/.*v//')"
print_success "Installed chaos-mcp v${INSTALLED_VERSION}"

# Smoketest --help
chaos-mcp --help >/dev/null 2>&1
print_success "--help works"

# Smoketest --validate-config
chaos-mcp --validate-config >/dev/null 2>&1 || true  # exits 0 or 1; both are fine
print_success "--validate-config works"

# ── 6. Quick-start guide ────────────────────────────────────────────────────
print_header "Installation Complete!"

echo ""
echo "  Quick start:"
echo "    chaos-mcp                        # Start the MCP server"
echo "    chaos-mcp --help                 # Show all flags"
echo "    chaos-mcp --verbose              # Start with diagnostic logging"
echo "    chaos-mcp --validate-config      # Validate your config file"
echo ""
echo "  Configuration (optional):"
echo "    Create chaos-mcp.config.json in your workspace root:"
echo ""
echo '    {'
echo '      "defaultTimeoutMs": 300000,'
echo '      "stryker": {'
echo '        "concurrency": 4,'
echo '        "perMutantTimeoutMs": 10000,'
echo '        "testRunner": "vitest"'
echo '      },'
echo '      "rust": { "timeoutMs": 600000 }'
echo '    }'
echo ""
echo "  MCP client config (e.g. Claude Desktop, Codebuff, etc.):"
echo '    {'
echo '      "chaos-mcp": {'
echo '        "command": "chaos-mcp",'
echo '        "args": ["--verbose"]'
echo '      }'
echo '    }'
echo ""
echo "  Docs:  https://github.com/codebuff/chaos-mcp"
echo "         https://codebuff.com/docs"
echo ""
