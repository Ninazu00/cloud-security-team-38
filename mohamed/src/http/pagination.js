/**
 * Limit and cursor handling for list endpoints.
 *
 * The cursor is opaque on purpose: it is a base64url-encoded `{ createdAt, id }`
 * pair, not an offset. Offsets drift - insert a row while a client is paging and
 * it sees the same course twice - whereas keyset paging asks "everything older
 * than this row", which is stable under inserts and cheap with the right index.
 *
 * Encoding is not a security control. The decoded values are only ever passed as
 * query parameters, which is what prevents injection; base64url buys two other
 * things - a client that hand-builds a cursor is a client that depends on its
 * contents, and encoding is the visible signal that this value is opaque and not
 * a page number to do arithmetic on.
 */

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

/** Read `limit` from a query string, falling back to the default. */
export function parseLimit(raw) {
  if (raw === undefined) return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return DEFAULT_LIMIT;
  return Math.min(value, MAX_LIMIT);
}

/** Encode the position of the last row on a page. */
export function encodeCursor({ createdAt, id }) {
  const payload = JSON.stringify({ c: new Date(createdAt).toISOString(), i: id });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/**
 * Decode a cursor, or return null when it is missing. A malformed cursor is a
 * client bug, not a server error: the list endpoints treat it as "start over"
 * rather than answering 500 for a value that came from a URL.
 */
export function decodeCursor(raw) {
  if (raw === undefined || raw === '') return null;

  try {
    const parsed = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (typeof parsed.c !== 'string' || typeof parsed.i !== 'string') return null;

    const createdAt = new Date(parsed.c);
    if (Number.isNaN(createdAt.getTime())) return null;

    return { createdAt, id: parsed.i };
  } catch {
    return null;
  }
}

/** A page is one row more than asked for: the extra row tells us there is a next page. */
export function toPage(rows, limit, keyOf = (row) => row) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  return {
    items,
    nextCursor: hasMore ? encodeCursor(keyOf(items[items.length - 1])) : null,
  };
}
