// Seat configuration persistence (non-secret). Stores adapter ids, requested
// models/effort, permission modes, and auth ENV NAMES — never secret values.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../storage/paths.mjs';

export const SCHEMA_CONFIG = 1;
const FILE = () => join(configDir(), 'config.json');

export function configExists() {
  return existsSync(FILE());
}

export function loadConfig() {
  if (!configExists()) return null;
  try {
    return JSON.parse(readFileSync(FILE(), 'utf8'));
  } catch {
    return null;
  }
}

export function saveConfig(cfg) {
  mkdirSync(configDir(), { recursive: true });
  const doc = { v: SCHEMA_CONFIG, ...cfg };
  writeFileSync(FILE(), JSON.stringify(doc, null, 2), { mode: 0o600 });
  return FILE();
}
