import fs from 'fs';
import path from 'path';

const STORE_DIR = process.env.STORE_DIR || '/data';

// Ensure directory exists on startup
try {
  fs.mkdirSync(STORE_DIR, { recursive: true });
} catch (err) {
  console.error(`❌ Cannot create store directory ${STORE_DIR}:`, err);
  console.error('   Mount a Railway volume at /data or set STORE_DIR env var');
}
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
