import fs from 'fs';
import path from 'path';

const STORE_DIR = process.env.STORE_DIR || '/tmp/tock-bot-data';
const STORE_FILE = path.join(STORE_DIR, 'state.json');

interface StoreData {
  cookies?: any[];
  payment?: any;
}

function ensureDir(): void {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }
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
  ensureDir();
  fs.writeFileSync(STORE_FILE, JSON.stringify(data));
}

export function saveToDisk(key: keyof StoreData, value: any): void {
  const data = readStore();
  data[key] = value;
  writeStore(data);
}

export function loadFromDisk(key: keyof StoreData): any {
  return readStore()[key] ?? null;
}
