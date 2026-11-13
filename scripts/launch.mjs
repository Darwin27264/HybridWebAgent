#!/usr/bin/env node

/**
 * Ofln-Scout Cross-Platform Unified Launcher
 *
 * One-click startup for:
 *   1. System 1 & 2 Daemon (WebSocket server on port 4040 + SQLite + ONNX Runtime)
 *   2. Desktop UI (Vite dev server on port 5173)
 *   3. Automatic browser launch (Windows / Linux / macOS)
 *
 * Flags:
 *   --daemon-only, --headless, -d   Run only the headless daemon (ideal for Linux servers)
 *   --ui-only, -u                  Run only the desktop UI
 *   --no-browser                   Do not automatically open the web browser
 *   --prewarm                      Run model pre-warming before starting services
 *   --port <number>                Custom daemon WebSocket port (default: 4040)
 *   --ui-port <number>             Custom UI HTTP port (default: 5173)
 *   --host <string>                Host interface (default: 127.0.0.1, or 0.0.0.0)
 */

import { spawn, exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// Terminal colors
const cyan = (text) => `\x1b[36m${text}\x1b[0m`;
const magenta = (text) => `\x1b[35m${text}\x1b[0m`;
const green = (text) => `\x1b[32m${text}\x1b[0m`;
const yellow = (text) => `\x1b[33m${text}\x1b[0m`;
const red = (text) => `\x1b[31m${text}\x1b[0m`;
const bold = (text) => `\x1b[1m${text}\x1b[0m`;

// Parse CLI flags
const args = process.argv.slice(2);
const isDaemonOnly = args.includes('--daemon-only') || args.includes('--headless') || args.includes('-d');
const isUiOnly = args.includes('--ui-only') || args.includes('-u');
const noBrowser = args.includes('--no-browser') || Boolean(process.env.NO_BROWSER);
const shouldPrewarm = args.includes('--prewarm');
const showHelp = args.includes('--help') || args.includes('-h');

const getArgValue = (flag, defaultValue) => {
  const index = args.indexOf(flag);
  if (index !== -1 && index + 1 < args.length) {
    return args[index + 1];
  }
  return defaultValue;
};

const DAEMON_PORT = parseInt(getArgValue('--port', process.env.PORT || '4040'), 10);
const DAEMON_HOST = getArgValue('--host', process.env.HOST || '127.0.0.1');
const UI_PORT = parseInt(getArgValue('--ui-port', process.env.UI_PORT || '5173'), 10);

if (showHelp) {
  console.log(`
${bold('Ofln-Scout Unified Launcher')}

${bold('Usage:')}
  node scripts/launch.mjs [options]
  launch.bat [options] (Windows)
  ./launch.sh [options] (Linux / macOS)

${bold('Options:')}
  --daemon-only, --headless, -d   Run only the headless daemon (ideal for Linux servers)
  --ui-only, -u                  Run only the desktop UI
  --no-browser                   Do not open the browser automatically
  --prewarm                      Run model weights pre-warming first
  --port <number>                Daemon WebSocket port (default: 4040)
  --ui-port <number>             Vite UI HTTP port (default: 5173)
  --host <string>                Host interface (default: 127.0.0.1)
  --help, -h                     Display this help screen
`);
  process.exit(0);
}

console.log(`
${green('================================================================')}
${green('        Ofln-Scout: Offline System 1 + 2 Local Orchestrator     ')}
${green('================================================================')}
`);

const children = [];
let isShuttingDown = false;

// Check if a TCP port is open and listening
function checkPortOpen(port, host = '127.0.0.1', timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(true);
      }
    });

    const onFail = () => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(false);
      }
    };

    socket.once('timeout', onFail);
    socket.once('error', onFail);
    socket.connect(port, host);
  });
}

// Poll until port is open or timeout
async function waitForPort(port, host = '127.0.0.1', maxWaitMs = 15000, intervalMs = 250) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (isShuttingDown) return false;
    const open = await checkPortOpen(port, host, 300);
    if (open) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// Open URL in default browser
function openBrowser(url) {
  const platform = os.platform();
  let cmd = '';

  if (platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else if (platform === 'darwin') {
    cmd = `open "${url}"`;
  } else {
    // Linux / BSD - check if DISPLAY is set
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      console.log(`${yellow('[Launcher]')} No graphical display detected. Skipping browser launch.`);
      return;
    }
    cmd = `xdg-open "${url}" >/dev/null 2>&1 || sensible-browser "${url}" >/dev/null 2>&1`;
  }

  try {
    exec(cmd, (err) => {
      if (err) {
        console.log(`${yellow('[Launcher]')} Could not auto-launch browser. Please navigate to: ${bold(url)}`);
      }
    });
  } catch (err) {
    console.log(`${yellow('[Launcher]')} Could not auto-launch browser: ${err.message}`);
  }
}

// Clean child process spawn with output prefixing
function startService({ name, prefixColor, command, args, cwd, env = {} }) {
  const isWindows = process.platform === 'win32';
  const child = spawn(command, args, {
    cwd,
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: isWindows,
    detached: !isWindows,
    env: { ...process.env, ...env }
  });

  children.push(child);

  child.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (line.trim()) {
        console.log(`${prefixColor(`[${name}]`)} ${line}`);
      }
    }
  });

  child.stderr.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (line.trim()) {
        console.error(`${prefixColor(`[${name}]`)} ${line}`);
      }
    }
  });

  child.on('close', (code) => {
    if (!isShuttingDown) {
      console.log(`${prefixColor(`[${name}]`)} Process exited with code ${code}`);
      if (code !== 0 && code !== null) {
        shutdown(code);
      }
    }
  });

  child.on('error', (err) => {
    console.error(`${prefixColor(`[${name}]`)} Failed to start process:`, err);
  });

  return child;
}

// Graceful shutdown sequence
function shutdown(exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n${yellow('[Launcher] Shutting down services cleanly...')}`);

  for (const child of children) {
    try {
      if (process.platform === 'win32') {
        exec(`taskkill /pid ${child.pid} /T /F`, () => {});
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      }
    } catch (_) {}
  }

  setTimeout(() => {
    console.log(`${green('[Launcher] All services stopped.')}`);
    process.exit(exitCode);
  }, 600);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGHUP', () => shutdown(0));

async function main() {
  // Pre-flight check: ensure monorepo dependencies are present
  const rootNodeModules = path.join(ROOT_DIR, 'node_modules');
  if (!existsSync(rootNodeModules)) {
    console.log(`${yellow('[Launcher]')} node_modules not detected. Installing dependencies via pnpm...`);
    const isWindows = process.platform === 'win32';
    await new Promise((resolve, reject) => {
      const installer = spawn(isWindows ? 'pnpm.cmd' : 'pnpm', ['install'], {
        cwd: ROOT_DIR,
        stdio: 'inherit',
        shell: isWindows
      });
      installer.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pnpm install failed (${code})`))));
    });
  }

  // Optional pre-warm
  if (shouldPrewarm) {
    console.log(`${cyan('[Launcher]')} Running model pre-warm...`);
    await new Promise((resolve) => {
      const pw = spawn('node', ['scripts/prewarm-laya.mjs'], {
        cwd: ROOT_DIR,
        stdio: 'inherit'
      });
      pw.on('close', () => resolve());
    });
  }

  // 1. Launch Daemon (unless UI-only mode)
  if (!isUiOnly) {
    console.log(`${cyan('[Launcher]')} Starting Scout Daemon on ws://${DAEMON_HOST}:${DAEMON_PORT}...`);
    const daemonScript = path.join(ROOT_DIR, 'packages', 'daemon', 'dist', 'index.js');
    const hasDist = existsSync(daemonScript);

    if (hasDist) {
      startService({
        name: 'Daemon',
        prefixColor: cyan,
        command: 'node',
        args: [daemonScript],
        cwd: path.join(ROOT_DIR, 'packages', 'daemon'),
        env: {
          PORT: String(DAEMON_PORT),
          HOST: DAEMON_HOST
        }
      });
    } else {
      // Fallback to tsx if dist not yet compiled
      const isWindows = process.platform === 'win32';
      const npxCmd = isWindows ? 'npx.cmd' : 'npx';
      startService({
        name: 'Daemon',
        prefixColor: cyan,
        command: npxCmd,
        args: ['tsx', 'src/index.ts'],
        cwd: path.join(ROOT_DIR, 'packages', 'daemon'),
        env: {
          PORT: String(DAEMON_PORT),
          HOST: DAEMON_HOST
        }
      });
    }

    // Wait for daemon port
    const daemonReady = await waitForPort(DAEMON_PORT, DAEMON_HOST, 8000);
    if (daemonReady) {
      console.log(`${green('[Launcher]')} ✔ Daemon WebSocket ready at ws://${DAEMON_HOST}:${DAEMON_PORT}`);
    } else {
      console.log(`${yellow('[Launcher]')} Daemon starting up...`);
    }
  }

  // 2. Launch UI (unless daemon-only mode)
  if (!isDaemonOnly) {
    console.log(`${magenta('[Launcher]')} Starting Desktop UI dev server on http://localhost:${UI_PORT}...`);
    const isWindows = process.platform === 'win32';
    const npxCmd = isWindows ? 'npx.cmd' : 'npx';

    startService({
      name: 'UI',
      prefixColor: magenta,
      command: npxCmd,
      args: ['vite', '--port', String(UI_PORT)],
      cwd: path.join(ROOT_DIR, 'packages', 'desktop-ui'),
      env: {
        PORT: String(UI_PORT)
      }
    });

    const uiReady = await waitForPort(UI_PORT, '127.0.0.1', 12000);
    if (uiReady) {
      const url = `http://localhost:${UI_PORT}`;
      console.log(`${green('[Launcher]')} ✔ Desktop UI ready at ${bold(url)}`);

      if (!noBrowser) {
        console.log(`${green('[Launcher]')} Opening browser at ${bold(url)}...`);
        openBrowser(url);
      }
    }
  }

  console.log(`
${green('================================================================')}
${green('  ✔ Ofln-Scout is actively running!                             ')}
${green('  - Daemon WebSocket: ')} ws://${DAEMON_HOST}:${DAEMON_PORT}
${!isDaemonOnly ? `${green('  - Desktop UI:       ')} http://localhost:${UI_PORT}\n` : ''}${green('  Press [Ctrl+C] to gracefully stop all services.               ')}
${green('================================================================')}
`);
}

main().catch((err) => {
  console.error(`${red('[Launcher Fatal Error]')}`, err);
  shutdown(1);
});

