import { badRequest } from './errors.js';

/** Opaque keyset-pagination cursor: the last row's sort value + id. Tamper-safe because the value
 *  is only ever bound as a typed parameter (never concatenated into SQL). */
export function encodeCursor(value, id) {
  return Buffer.from(JSON.stringify([value, id]), 'utf8').toString('base64url');
}

export function decodeCursor(raw) {
  try {
    const [value, id] = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if ((typeof value !== 'string' && typeof value !== 'number') || !Number.isSafeInteger(id)) throw new Error('shape');
    return { value: String(value), id };
  } catch {
    throw badRequest('Invalid cursor');
  }
}
