// Legacy Council migration. Reads existing Council runs/events and maps fixed
// `sessions.claude`/`sessions.codex` to GENERIC seats. It is IDEMPOTENT and NEVER
// mutates the original legacy artifacts (it emits a new, versioned record). Missing
// model provenance is marked `unknown`; unattestable review integrity is
// `unattested`. Malformed/newer schemas are surfaced, never silently discarded.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const MIGRATION_VERSION = 1;

/** Map a legacy Council run object into the MoH run-record shape. */
export function migrateCouncilRun(legacy, { sourcePath = null } = {}) {
  if (!legacy || typeof legacy !== 'object') {
    return { ok: false, reason: 'legacy run is not an object', quarantined: true };
  }
  // Detect a newer/unknown schema — do NOT discard; quarantine with a note.
  const legacySchema = legacy.schema ?? legacy.version ?? null;
  if (typeof legacySchema === 'number' && legacySchema > 1000) {
    return { ok: false, reason: `unrecognized legacy schema ${legacySchema}`, quarantined: true, original: legacy };
  }

  const seats = [];
  const sessions = legacy.sessions || {};
  // Fixed Claude/Codex fields -> generic seats. Preserve original actor label.
  const legacyActors = legacy.actors || Object.keys(sessions);
  const knownOrder = ['claude', 'codex'];
  const order = [...new Set([...knownOrder.filter((a) => legacyActors.includes(a)), ...legacyActors])];
  order.forEach((actor, i) => {
    const s = sessions[actor] || {};
    seats.push({
      seatId: i === 0 ? 'seat-a' : `seat-${String.fromCharCode(97 + i)}`,
      label: actor === 'claude' ? 'Legacy Claude seat' : actor === 'codex' ? 'Legacy Codex seat' : `Legacy ${actor} seat`,
      legacyActor: actor,
      adapterId: actor === 'claude' ? 'claude-code' : actor === 'codex' ? 'codex-cli' : 'unknown',
      provenance: {
        // Legacy runs did not record trustworthy per-turn model identity.
        requestedModel: s.model ?? legacy.model ?? null,
        requestedModelSource: s.model ? 'config' : 'default',
        reportedModel: null,
        state: 'unknown',
        note: 'legacy run: runtime model identity not recorded; not reconstructed from assumptions',
        sessionId: s.sessionId ?? s.session_id ?? null,
      },
    });
  });

  const migrated = {
    v: MIGRATION_VERSION,
    migratedFrom: 'council',
    sourcePath,
    runId: legacy.runId || legacy.id || legacy.run_id || 'legacy-unknown',
    legacyBranch: legacy.branch || (legacy.runId ? `council/${legacy.runId}` : null),
    task: legacy.task || legacy.prompt || null,
    seats,
    leaderSeatId: mapLeader(legacy, order),
    verdict: legacy.verdict || 'unknown',
    reviewIntegrity: 'unattested', // exact binding cannot be demonstrated for legacy
    createdAt: legacy.createdAt || legacy.created_at || null,
    legacyPreserved: true,
  };
  return { ok: true, migrated };
}

function mapLeader(legacy, order) {
  const leader = legacy.leader || legacy.winner || legacy.chosen;
  if (!leader) return null;
  const idx = order.indexOf(leader);
  return idx >= 0 ? (idx === 0 ? 'seat-a' : `seat-${String.fromCharCode(97 + idx)}`) : null;
}

/** Scan a legacy Council state dir for run records (non-mutating). */
export function scanLegacyCouncil(dir) {
  const found = [];
  if (!dir || !existsSync(dir)) return found;
  const runsDir = existsSync(join(dir, 'runs')) ? join(dir, 'runs') : dir;
  let entries = [];
  try {
    entries = readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    const p = join(runsDir, e.name);
    let statePath = null;
    if (e.isDirectory()) {
      for (const cand of ['run.json', 'state.json', 'council.json']) {
        if (existsSync(join(p, cand))) {
          statePath = join(p, cand);
          break;
        }
      }
    } else if (e.isFile() && e.name.endsWith('.json')) {
      statePath = p;
    }
    if (statePath) {
      try {
        const legacy = JSON.parse(readFileSync(statePath, 'utf8'));
        found.push({ path: statePath, legacy });
      } catch {
        found.push({ path: statePath, legacy: null, error: 'unparseable' });
      }
    }
  }
  return found;
}

/** COUNCIL_* env compatibility for one release, with deprecation warnings. */
export function applyLegacyEnvCompat(logger = () => {}) {
  const map = [
    ['COUNCIL_STATE_DIR', 'MOH_STATE_DIR'],
    ['COUNCIL_CONFIG_DIR', 'MOH_CONFIG_DIR'],
    ['COUNCIL_CLAUDE_PATH', 'MOH_CLAUDE_PATH'],
    ['COUNCIL_CODEX_PATH', 'MOH_CODEX_PATH'],
  ];
  const applied = [];
  for (const [oldName, newName] of map) {
    if (process.env[oldName] !== undefined && process.env[newName] === undefined) {
      process.env[newName] = process.env[oldName];
      applied.push({ oldName, newName });
      logger(`[deprecation] ${oldName} is deprecated; use ${newName}. Honoring ${oldName} for this release.`);
    }
  }
  return applied;
}
