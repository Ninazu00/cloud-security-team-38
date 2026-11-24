/**
 * Small DOM helpers. There is no framework here on purpose: the pages are four
 * forms and four tables, and React would be more code than the app it renders.
 *
 * The one rule that matters: text always goes in through `textContent`, never
 * `innerHTML`. A course title is user input, and the CSP is the second line of
 * defence, not the first.
 */

/** Build an element: h('td', { class: 'muted' }, 'hello'). */
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;

    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'text') node.textContent = value;
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }

  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  return node;
}

/** Replace a container's children in one step. */
export function fill(node, ...children) {
  node.replaceChildren(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
}

export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const TYPES = ['lecture', 'lab', 'tutorial'];

/** "Mon 10:00–11:30" — the contract stores wall-clock times and a day number. */
export function timeRange(block) {
  return `${DAYS[block.dayOfWeek] ?? '?'} ${block.startTime}–${block.endTime}`;
}

/** Times sorted the way a timetable reads: by day, then by start. */
export function sortTimes(times = []) {
  return [...times].sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime));
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

/**
 * Show a message in a prepared `.alert` element.
 *
 * `tone` is one of error | ok | info | warn. A message is always text: server
 * errors carry a human sentence and an id, never markup.
 */
export function showAlert(node, tone, message) {
  if (!node) return;
  node.className = `alert ${tone}`;
  node.textContent = message;
  node.hidden = false;
}

export function hideAlert(node) {
  if (!node) return;
  node.hidden = true;
  node.textContent = '';
}
