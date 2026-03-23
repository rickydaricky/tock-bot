import fs from 'fs';
import path from 'path';

// Try /data (Railway volume), fall back to /tmp if not writable
function resolveStoreDir(): string {
  const preferred = process.env.STORE_DIR || '/data';
  try {
    fs.mkdirSync(preferred, { recursive: true });
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch {
    const fallback = '/tmp/tock-bot-data';
    fs.mkdirSync(fallback, { recursive: true });
    console.log(`⚠️ Cannot write to ${preferred}, using ${fallback} (data won't persist across deploys)`);
    return fallback;
  }
}

const STORE_DIR = resolveStoreDir();
const STORE_FILE = path.join(STORE_DIR, 'state.json');

interface StoreData {
  cookies?: any[];
  payment?: any;
}

function readStore(): StoreData {
  try {
    if (fs.existsSync(STORE_FILE)) {
      return JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

function writeStore(data: StoreData): void {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(data));
  } catch (err) {
    console.error('Failed to write store:', err);
  }
}

export function saveToDisk(key: keyof StoreData, value: any): void {
  const data = readStore();
  data[key] = value;
  writeStore(data);
}

export function loadFromDisk(key: keyof StoreData): any {
  return readStore()[key] ?? null;
}
