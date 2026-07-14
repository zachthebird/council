// Platform-appropriate user state/config directories. New application data lives
// OUTSIDE the installed package. Honors XDG on Linux and MOH_STATE_DIR override.
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const APP = 'moh';

function xdg(envName, fallbackSub) {
  const explicit = process.env[envName];
  if (explicit && explicit.trim()) return join(explicit, APP);
  return join(homedir(), ...fallbackSub, APP);
}

/** Durable run/event/receipt storage. */
export function stateDir() {
  if (process.env.MOH_STATE_DIR) return process.env.MOH_STATE_DIR;
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', APP);
  if (platform() === 'win32') {
    const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(base, APP, 'state');
  }
  return xdg('XDG_STATE_HOME', ['.local', 'state']);
}

/** User configuration (seats, defaults). */
export function configDir() {
  if (process.env.MOH_CONFIG_DIR) return process.env.MOH_CONFIG_DIR;
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', APP, 'config');
  if (platform() === 'win32') {
    const base = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(base, APP, 'config');
  }
  return xdg('XDG_CONFIG_HOME', ['.config']);
}

/** Ephemeral run workspaces (git checkouts). */
export function workspacesDir() {
  return join(stateDir(), 'workspaces');
}

export function runsDir() {
  return join(stateDir(), 'runs');
}

/** Legacy Council data locations we still read (never mutate). */
export function legacyCouncilDirs() {
  const candidates = [];
  if (process.env.COUNCIL_STATE_DIR) candidates.push(process.env.COUNCIL_STATE_DIR);
  candidates.push(join(homedir(), '.council'));
  if (platform() === 'darwin') candidates.push(join(homedir(), 'Library', 'Application Support', 'council'));
  candidates.push(join(homedir(), '.local', 'state', 'council'));
  return candidates;
}
