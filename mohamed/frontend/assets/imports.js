/**
 * Import a catalogue CSV, and read the history of previous attempts.
 *
 * "Check first" sends the same file with `?dryRun=true`: the server parses,
 * validates and rolls back, so a dry run leaves no rows and no history entry. It
 * is the difference between finding out about a clash now and finding out after
 * the file has been refused for real.
 *
 * A refused file is still recorded (`status: failed`) — that is deliberate, so
 * "it was rejected" leaves evidence instead of vanishing.
 */

import { api, ApiError } from './api.js';
import { boot, isAdmin } from './session.js';
import { h, fill, showAlert, hideAlert, fmtDate } from './dom.js';

const fileInput = document.querySelector('#file');
const dryButton = document.querySelector('[data-dry]');
const commitButton = document.querySelector('[data-commit]');
const alertBox = document.querySelector('[data-alert]');

const result = document.querySelector('[data-result]');
const resultTitle = document.querySelector('[data-result-title]');
const resultMeta = document.querySelector('[data-result-meta]');
const resultAlert = document.querySelector('[data-result-alert]');
const errorWrap = document.querySelector('[data-error-wrap]');
const errorRows = document.querySelector('[data-errors]');
const errorNote = document.querySelector('[data-error-note]');

const historyRows = document.querySelector('[data-history]');
const empty = document.querySelector('[data-empty]');
const statusFilter = document.querySelector('#status');

const detail = document.querySelector('[data-detail]');
const detailTitle = document.querySelector('[data-detail-title]');
const detailMeta = document.querySelector('[data-detail-meta]');
const detailWrap = document.querySelector('[data-detail-wrap]');
const detailErrors = document.querySelector('[data-detail-errors]');

const SCROLL_LIMIT = 100;

function errorTable(tbody, errors) {
  fill(
    tbody,
    ...errors.map((item) =>
      h('tr', {}, h('td', {}, String(item.row)), h('td', {}, item.field ?? ''), h('td', {}, item.message)),
    ),
  );
}

/** Show the outcome of one upload attempt (dry or real). */
function showOutcome({ title, meta: summary, tone, errors = [], totalErrors = 0, truncated = false }) {
  result.hidden = false;
  resultTitle.textContent = title;
  resultMeta.textContent = summary;
  showAlert(resultAlert, tone, tone === 'ok' ? 'No problems found.' : 'The file was not imported.');

  errorWrap.hidden = errors.length === 0;
  errorTable(errorRows, errors);

  errorNote.hidden = !truncated;
  errorNote.textContent = truncated
    ? `Showing the first ${errors.length} of ${totalErrors} problems.`
    : '';
}

function busy(state) {
  dryButton.disabled = state;
  commitButton.disabled = state;
  dryButton.textContent = state ? 'Working…' : 'Check first';
  commitButton.textContent = state ? 'Working…' : 'Import';
}

async function send(dryRun) {
  const file = fileInput.files?.[0];
  hideAlert(alertBox);
  result.hidden = true;

  if (!file) {
    showAlert(alertBox, 'error', 'Choose a CSV file first.');
    return;
  }

  busy(true);

  try {
    if (dryRun) {
      const outcome = await api.uploadImport(file, { dryRun: true });
      showOutcome({
        title: 'Checked, not imported',
        meta: `${file.name} · ${outcome.rowCount} row(s) read`,
        tone: 'ok',
      });
      return;
    }

    const outcome = await api.uploadImport(file, { dryRun: false });
    const { courses, sections, times } = outcome.imported ?? {};
    showOutcome({
      title: 'Imported',
      meta: `${file.name} · ${outcome.rowCount} row(s) · ${courses ?? 0} course(s), ${sections ?? 0} section(s), ${times ?? 0} block(s)`,
      tone: 'ok',
    });
    await loadHistory();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      location.replace('index.html');
      return;
    }

    const details = error.details ?? {};

    if (error.code === 'IMPORT_INVALID') {
      showOutcome({
        title: 'Nothing was imported',
        meta: `${file.name} · ${details.totalErrors ?? details.errors?.length ?? 0} problem(s)`,
        tone: 'error',
        errors: details.errors ?? [],
        totalErrors: details.totalErrors ?? 0,
        truncated: Boolean(details.truncated),
      });
      await loadHistory();
      return;
    }

    if (error.code === 'ALREADY_IMPORTED') {
      showOutcome({
        title: 'Already imported',
        meta: `This exact file was committed earlier as ${details.importId ?? 'another import'}.`,
        tone: 'warn',
      });
      return;
    }

    showAlert(alertBox, 'error', error.message ?? 'The upload failed.');
  } finally {
    busy(false);
  }
}

function historyRow(item) {
  const when = fmtDate(item.committedAt ?? item.createdAt);
  const badge = h(
    'span',
    { class: item.status === 'committed' ? 'badge live' : 'badge failed' },
    item.status,
  );

  return h(
    'tr',
    {},
    h('td', { class: 'small' }, when),
    h('td', { class: 'mono small' }, item.filename ?? '—'),
    h('td', {}, badge),
    h('td', {}, String(item.rowCount ?? 0)),
    h('td', {}, String(item.errorCount ?? 0)),
    h('td', { class: 'small' }, item.uploadedBy?.email ?? '—'),
    h('td', { class: 'actions' }, h('button', { class: 'btn secondary small', type: 'button', onclick: () => void showDetail(item.id) }, 'Report')),
  );
}

async function loadHistory() {
  try {
    const page = await api.listImports({
      status: statusFilter.value || undefined,
      limit: 25,
    });

    fill(historyRows, ...page.items.map(historyRow));
    empty.hidden = page.items.length > 0;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      location.replace('index.html');
      return;
    }
    showAlert(alertBox, 'error', error.message ?? 'Could not load the history.');
  }
}

async function showDetail(id) {
  try {
    const item = await api.getImport(id);
    const errors = (item.report?.errors ?? []).slice(0, SCROLL_LIMIT);

    detail.hidden = false;
    detailTitle.textContent = item.filename ?? 'Import';
    detailMeta.textContent = `${item.status} · ${item.rowCount ?? 0} row(s), ${item.errorCount ?? 0} error(s) · ${fmtDate(item.committedAt ?? item.createdAt)}`;
    detailWrap.hidden = errors.length === 0;
    errorTable(detailErrors, errors);
    detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    showAlert(alertBox, 'error', error.message ?? 'Could not load that import.');
  }
}

/* --- wiring -------------------------------------------------------------- */

dryButton.addEventListener('click', () => void send(true));
commitButton.addEventListener('click', () => void send(false));
document.querySelector('[data-refresh]').addEventListener('click', () => void loadHistory());
statusFilter.addEventListener('change', () => void loadHistory());
document.querySelector('[data-detail-close]').addEventListener('click', () => {
  detail.hidden = true;
});

fileInput.addEventListener('change', () => {
  result.hidden = true;
  hideAlert(alertBox);
});

const user = await boot({ active: 'imports', admin: true });
if (user && isAdmin()) {
  await loadHistory();
}
