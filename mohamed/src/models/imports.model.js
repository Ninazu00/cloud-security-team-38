import { toPage } from '../http/pagination.js';

/**
 * Import history: the audit trail of what was uploaded and what happened.
 *
 * Two writes, on purpose:
 *   - `insertCommitted` runs inside the import's transaction, so a committed row
 *     and the data it describes land together or not at all;
 *   - `insertFailed` runs *after* that transaction rolled back, in its own, so a
 *     rejection is still on the record. Losing the evidence along with the data
 *     is the failure mode worth avoiding here.
 */

const COLUMNS = 'i.id, i.filename, i.status, i.row_count, i.error_count, i.report, i.created_by, i.created_at, i.committed_at';

function toImport(row) {
  return {
    id: row.id,
    filename: row.filename,
    status: row.status,
    rowCount: row.row_count,
    errorCount: row.error_count,
    report: row.report,
    uploadedBy: row.uploaded_by_id ? { id: row.uploaded_by_id, email: row.uploaded_by_email } : null,
    createdAt: row.created_at,
    committedAt: row.committed_at,
  };
}

export function createImportsModel({ query }) {
  if (!query) throw new Error('createImportsModel needs query from db.js.');

  /** The idempotency lookup: only committed rows claim a hash. */
  async function findCommittedByHash(hash) {
    const { rows } = await query(
      `select id from imports where content_hash = $1 and status = 'committed' limit 1`,
      [hash],
    );
    return rows[0]?.id ?? null;
  }

  async function findById(id) {
    const { rows } = await query(
      `select ${COLUMNS}, u.id as uploaded_by_id, u.email as uploaded_by_email
         from imports i left join users u on u.id = i.created_by
        where i.id = $1`,
      [id],
    );
    return rows[0] ? toImport(rows[0]) : null;
  }

  async function list({ status, limit, cursor }) {
    const conditions = [];
    const params = [];

    if (status) {
      params.push(status);
      conditions.push(`i.status = $${params.length}`);
    }
    if (cursor) {
      params.push(cursor.createdAt.toISOString(), cursor.id);
      conditions.push(`(i.created_at, i.id) < ($${params.length - 1}, $${params.length})`);
    }

    params.push(limit + 1);
    const { rows } = await query(
      `select ${COLUMNS}, u.id as uploaded_by_id, u.email as uploaded_by_email
         from imports i left join users u on u.id = i.created_by
        ${conditions.length > 0 ? `where ${conditions.join(' and ')}` : ''}
        order by i.created_at desc, i.id desc
        limit $${params.length}`,
      params,
    );

    return toPage(rows.map(toImport), limit);
  }

  /** Inside the import transaction: the row and the data it describes commit together. */
  async function insertCommitted(client, { hash, filename, rowCount, createdBy }) {
    const { rows } = await client.query(
      `insert into imports (content_hash, filename, status, row_count, error_count, created_by, committed_at)
       values ($1, $2, 'committed', $3, 0, $4, now())
       returning id, committed_at`,
      [hash, filename, rowCount, createdBy],
    );
    return rows[0];
  }

  /** After the rollback, in its own transaction: a rejection must still be on the record. */
  async function insertFailed({ hash, filename, rowCount, errorCount, report, createdBy }) {
    const { rows } = await query(
      `insert into imports (content_hash, filename, status, row_count, error_count, report, created_by)
       values ($1, $2, 'failed', $3, $4, $5, $6)
       returning id, created_at`,
      [hash, filename, rowCount, errorCount, report, createdBy],
    );
    return rows[0];
  }

  return { findCommittedByHash, findById, list, insertCommitted, insertFailed };
}
