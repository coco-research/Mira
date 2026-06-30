#!/bin/bash

# Locally Uncensored — Developer Setup (Linux/macOS)
# Runs LU in dev-mode (Vite at localhost:5173). For the installed
# desktop experience, build with `npm run tauri:build` or grab the
# AppImage/deb/rpm from Releases once a build is posted for your OS.

set -e

PURPLE='\033[0;35m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
NC='\033[0m'

echo ""
echo -e "${YELLOW}   +---------------------------------------------------------------+${NC}"
echo -e "${YELLOW}   | This script starts Locally Uncensored in DEVELOPER mode.     |${NC}"
echo -e "${YELLOW}   | It runs via Vite at http://localhost:5173 in your browser,   |${NC}"
echo -e "${YELLOW}   | which has fewer features than a standalone desktop build.    |${NC}"
echo -e "${YELLOW}   |                                                               |${NC}"
echo -e "${YELLOW}   | Just want to USE the app? Download the installer instead:    |${NC}"
echo -e "${CYAN}   | https://github.com/PurpleDoubleD/locally-uncensored/releases |${NC}"
echo -e "${YELLOW}   +---------------------------------------------------------------+${NC}"
echo ""
read -p "Continue with developer setup? (y/N) " answer
case "$answer" in
  [Yy]*) echo "" ;;
  *) echo -e "Cancelled. Download the installer from:\n  ${CYAN}https://github.com/PurpleDoubleD/locally-uncensored/releases/latest${NC}"; exit 0 ;;
esac

echo -e "${PURPLE}"
echo "    ╔═══════════════════════════════════════════╗"
echo "    ║         LOCALLY  UNCENSORED               ║"
echo "    ║   Private, local AI. No cloud.            ║"
echo "    ║   No censorship. Chat + Images + Video.   ║"
echo "    ╚═══════════════════════════════════════════╝"
echo -e "${NC}"

# Helper function
check_cmd() {
    command -v "$1" &>/dev/null
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 1. Check Node.js
echo -e "    ${YELLOW}[1/5] Checking Node.js...${NC}"
if check_cmd node; then
    NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VER" -ge 18 ]; then
        echo -e "    ${GREEN}[+] Node.js $(node -v)${NC}"
    else
        echo -e "    ${YELLOW}[!] Node.js $(node -v) found but v18+ required.${NC}"
        echo -e "    ${DIM}    Install via: https://nodejs.org/ or use nvm${NC}"
        exit 1
    fi
else
    echo -e "    ${YELLOW}[!] Node.js not found.${NC}"
    echo ""
    echo "    Install Node.js 18+ first:"
    echo "      macOS:  brew install node"
    echo "      Ubuntu: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"
    echo "      Arch:   sudo pacman -S nodejs npm"
    echo "      Or:     https://nodejs.org/"
    echo ""
    exit 1
fi

# 2. Check Git
echo -e "    ${YELLOW}[2/5] Checking Git...${NC}"
if check_cmd git; then
    echo -e "    ${GREEN}[+] Git $(git --version | cut -d' ' -f3)${NC}"
else
    echo -e "    ${YELLOW}[!] Git not found. Install it:${NC}"
    echo "      macOS:  xcode-select --install"
    echo "      Ubuntu: sudo apt install git"
    exit 1
fi

# 3. Check/Install Ollama
echo -e "    ${YELLOW}[3/5] Checking Ollama...${NC}"
if check_cmd ollama; then
    echo -e "    ${GREEN}[+] Ollama found${NC}"
else
    echo -e "    ${YELLOW}[?] Ollama not found. Install it? (recommended for AI chat)${NC}"
    read -p "    Install Ollama? [Y/n] " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Nn]$ ]]; then
        echo -e "    ${DIM}    Skipping Ollama. You can install it later from https://ollama.com/${NC}"
    else
        echo -e "    ${YELLOW}    Installing Ollama...${NC}"
        curl -fsSL https://ollama.com/install.sh | sh
        echo -e "    ${GREEN}[+] Ollama installed${NC}"
    fi
fi

# Start Ollama if installed but not running
if check_cmd ollama; then
    if ! pgrep -x "ollama" > /dev/null 2>&1; then
        echo -e "    ${DIM}    Starting Ollama...${NC}"
        ollama serve &>/dev/null &
        sleep 3
    fi
fi

# 4. Install npm dependencies
echo ""
echo -e "    ${YELLOW}[4/5] Installing dependencies...${NC}"
npm install --loglevel=error
echo -e "    ${GREEN}[+] Dependencies installed${NC}"

# 5. Check for AI models
echo ""
echo -e "    ${YELLOW}[5/5] Checking AI models...${NC}"
if check_cmd ollama; then
    MODEL_COUNT=$(ollama list 2>/dev/null | tail -n +2 | wc -l)
    if [ "$MODEL_COUNT" -eq 0 ]; then
        echo -e "    ${YELLOW}[?] No AI models found.${NC}"
        echo -e "    ${DIM}    Download Llama 3.1 8B Abliterated (~5.7 GB)?${NC}"
        read -p "    Download recommended model? [Y/n] " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Nn]$ ]]; then
            echo -e "    ${YELLOW}    Downloading... grab a coffee.${NC}"
            ollama pull mannix/llama3.1-8b-abliterated:q5_K_M
            echo -e "    ${GREEN}[+] Model installed${NC}"
        else
            echo -e "    ${DIM}    Skipped. Install models later via the Model Manager in the app.${NC}"
        fi
    else
        echo -e "    ${GREEN}[+] Found $MODEL_COUNT model(s)${NC}"
    fi
else
    echo -e "    ${DIM}    Ollama not installed — skipping model check${NC}"
fi

# Done
echo ""
echo -e "    ${GREEN}═══════════════════════════════════════════${NC}"
echo -e "    ${GREEN}Setup complete! Starting app...${NC}"
echo -e "    ${GREEN}═══════════════════════════════════════════${NC}"
echo ""
echo -e "    ${DIM}Opening http://localhost:5173 in your browser...${NC}"
echo ""

# Try to open browser
if check_cmd xdg-open; then
    xdg-open http://localhost:5173 &>/dev/null &
elif check_cmd open; then
    open http://localhost:5173
fi

npm run dev
