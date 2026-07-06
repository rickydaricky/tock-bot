/**
 * store.ts — Durable, on-disk persistence for the sniper server's long-lived secrets.
 *
 * Responsibility: read/write a single JSON blob (`state.json`) holding the pieces of
 * state that must survive process restarts and redeploys — Tock session cookies, the
 * Stripe payment payload, and Tock login credentials. On Railway the file lives on the
 * mounted `/data` volume so it persists across deploys; everything else in the server
 * is in-memory and rebuilt on boot.
 *
 * Design notes:
 *  - Deliberately a flat key/value store over one JSON file (not a DB). The dataset is
 *    tiny (a handful of keys) and read/written rarely, so simplicity wins.
 *  - All I/O is synchronous and best-effort: failures are logged, never thrown. Callers
 *    treat "no state" (missing/corrupt file) as a valid cold-start condition, so a bad
 *    read must degrade to `{}` rather than crash the booking server.
 *
 * Key exports:
 *  - `saveToDisk(key, value)` — persist one field, merging into the existing blob.
 *  - `loadFromDisk(key)` — read one field, or `null` if absent.
 */
import fs from 'fs';
import path from 'path';

/**
 * Base directory for the state file. Defaults to `/data`, the conventional Railway
 * volume mount point; overridable via STORE_DIR for local dev or alternate hosts.
 */
const STORE_DIR = process.env.STORE_DIR || '/data';

// Ensure directory exists on startup. If the volume isn't mounted this throws, but we
// only log it — the process still boots (persistence is degraded, not fatal), and the
// hint tells the operator to mount the Railway volume or point STORE_DIR elsewhere.
try {
  fs.mkdirSync(STORE_DIR, { recursive: true });
} catch (err) {
  console.error(`❌ Cannot create store directory ${STORE_DIR}:`, err);
  console.error('   Mount a Railway volume at /data or set STORE_DIR env var');
}
/** Full path to the single JSON blob that backs the entire store. */
const STORE_FILE = path.join(STORE_DIR, 'state.json');

/**
 * Shape of the persisted blob. Every field is optional because the file starts empty
 * (cold start) and is populated incrementally as secrets are captured.
 *  - `cookies`     — Tock session cookies, used to keep the headless browser logged in.
 *  - `payment`     — Stripe payment details for auto-purchase (loosely typed; mirrors
 *                    the extension's payload).
 *  - `tockCredentials` — email/password for automated re-login when the session expires.
 */
interface StoreData {
  cookies?: any[];
  opentableCookies?: any[];
  payment?: any;
  tockCredentials?: { email: string; password: string };
}

/**
 * Load and parse the entire state blob from disk.
 *
 * Returns an empty object when the file is missing OR unparseable — a corrupt/partial
 * write must not brick the server, so any error is swallowed and treated as cold start.
 * This is the invariant every caller relies on: reads never throw.
 */
function readStore(): StoreData {
  try {
    if (fs.existsSync(STORE_FILE)) {
      return JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

/**
 * Overwrite the entire state blob on disk. Best-effort: a write failure (e.g. volume
 * unmounted or read-only) is logged, not thrown, so a persistence outage never takes
 * down an in-flight booking. Not atomic — the whole file is rewritten each call.
 */
function writeStore(data: StoreData): void {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(data));
  } catch (err) {
    console.error('Failed to write store:', err);
  }
}

/**
 * Persist a single field, merging it into whatever is already on disk.
 *
 * Implemented as read-modify-write over the whole blob so setting one key never clobbers
 * the others. Callers write one secret at a time (cookies, payment, credentials), so this
 * merge semantics is what keeps them independent.
 */
export function saveToDisk(key: keyof StoreData, value: any): void {
  const data = readStore();
  data[key] = value;
  writeStore(data);
}

/**
 * Read a single persisted field, normalizing "absent" to `null` (never `undefined`) so
 * callers get one consistent sentinel to branch on for cold-start handling.
 */
export function loadFromDisk(key: keyof StoreData): any {
  return readStore()[key] ?? null;
}
