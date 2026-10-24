// Minimal JSON-file store: one file per record under data/<collection>/<id>.json.
import { mkdir, readFile, writeFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const COLLECTIONS = ['documents', 'tests', 'attempts', 'users', 'sessions', 'courses'];
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function initStore() {
  for (const collection of COLLECTIONS) {
    await mkdir(path.join(DATA_DIR, collection), { recursive: true });
  }
}

export const newId = () => randomUUID();

function recordPath(collection, id) {
  // Ids come from URLs, so only accept our own UUID format (blocks path traversal).
  if (!COLLECTIONS.includes(collection) || !ID_PATTERN.test(String(id))) return null;
  return path.join(DATA_DIR, collection, `${id}.json`);
}

export async function get(collection, id) {
  const file = recordPath(collection, id);
  if (!file) return null;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function put(collection, record) {
  const file = recordPath(collection, record.id);
  if (!file) throw new Error(`Invalid record id: ${record.id}`);
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(record));
  await rename(tmp, file);
  return record;
}

export async function remove(collection, id) {
  const file = recordPath(collection, id);
  if (!file) return;
  try {
    await unlink(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

export async function list(collection, predicate = () => true) {
  const dir = path.join(DATA_DIR, collection);
  const names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  const records = [];
  for (const name of names) {
    try {
      const record = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
      if (predicate(record)) records.push(record);
    } catch {
      // Skip unreadable or half-written files.
    }
  }
  return records;
}
