/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'container';

/**
 * Detect the VZ network bridge IP — the address Apple Container VMs use to
 * reach the host. Apple Container assigns the host a fixed IP on the
 * 192.168.64.0/24 subnet (standard VirtioFS/VZ networking on macOS).
 * Returns null when not found (non-Apple-Container environments).
 */
function detectVZBridgeIP(): string | null {
  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && addr.address.startsWith('192.168.64.')) {
        return addr.address;
      }
    }
  }
  return null;
}

/**
 * Hostname/IP containers use to reach the host machine.
 * Apple Container (macOS): VZ bridge IP (e.g. 192.168.64.1) — no DNS alias.
 * Docker (Linux/Docker Desktop): host.docker.internal.
 */
export const CONTAINER_HOST_GATEWAY: string = (() => {
  if (process.env.CREDENTIAL_PROXY_HOST) return process.env.CREDENTIAL_PROXY_HOST;
  if (os.platform() === 'darwin') {
    const vzIP = detectVZBridgeIP();
    if (vzIP) return vzIP;
  }
  return 'host.docker.internal';
})();

/**
 * Address the credential proxy binds to.
 * Apple Container (macOS): bind to the VZ bridge IP so only container VMs
 *   can reach the proxy — not other processes on the LAN.
 * Docker Desktop (macOS fallback): 127.0.0.1 — VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP.
 */
export const PROXY_BIND_HOST: string = (() => {
  if (process.env.CREDENTIAL_PROXY_HOST) return process.env.CREDENTIAL_PROXY_HOST;
  if (os.platform() === 'darwin') {
    // For Apple Container: bind to the same VZ bridge IP the containers use as gateway
    const vzIP = detectVZBridgeIP();
    if (vzIP) return vzIP;
    return '127.0.0.1'; // Docker Desktop fallback
  }
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';
  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  return '0.0.0.0';
})();

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return [
    '--mount',
    `type=bind,source=${hostPath},target=${containerPath},readonly`,
  ];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} system status`, { stdio: 'pipe' });
    logger.debug('Container runtime already running');
  } catch {
    logger.info('Starting container runtime...');
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} system start`, {
        stdio: 'pipe',
        timeout: 30000,
      });
      logger.info('Container runtime started');
    } catch (err) {
      logger.error({ err }, 'Failed to start container runtime');
      console.error(
        '\n╔════════════════════════════════════════════════════════════════╗',
      );
      console.error(
        '║  FATAL: Container runtime failed to start                      ║',
      );
      console.error(
        '║                                                                ║',
      );
      console.error(
        '║  Agents cannot run without a container runtime. To fix:        ║',
      );
      console.error(
        '║  1. Ensure Apple Container is installed                        ║',
      );
      console.error(
        '║  2. Run: container system start                                ║',
      );
      console.error(
        '║  3. Restart NanoClaw                                           ║',
      );
      console.error(
        '╚════════════════════════════════════════════════════════════════╝\n',
      );
      throw new Error('Container runtime is required but failed to start');
    }
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(`${CONTAINER_RUNTIME_BIN} ls --format json`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const containers: { status: string; configuration: { id: string } }[] =
      JSON.parse(output || '[]');
    const orphans = containers
      .filter(
        (c) =>
          c.status === 'running' && c.configuration.id.startsWith('nanoclaw-'),
      )
      .map((c) => c.configuration.id);
    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
