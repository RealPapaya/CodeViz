// frontend/utils/format.js — Formatting helpers
import { parseISO, formatDistanceToNow, format } from 'date-fns';
import { zhTW, enUS } from 'date-fns/locale';
import numeral from 'numeral';
import i18next from 'i18next';

const LOCALE_MAP = { 'zh-TW': zhTW, 'en': enUS };

function getLocale() {
  return LOCALE_MAP[i18next.language] ?? enUS;
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * e.g. 75123 → "1m 15.1s"
 */
export function formatDuration(ms) {
  if (ms == null || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = ((ms % 60_000) / 1000).toFixed(1);
  return `${mins}m ${secs}s`;
}

/**
 * Format an ISO timestamp relative to now.
 * e.g. "2 hours ago"
 */
export function formatTimestamp(iso) {
  if (!iso) return '—';
  try {
    return formatDistanceToNow(parseISO(iso), { addSuffix: true, locale: getLocale() });
  } catch {
    return iso;
  }
}

/**
 * Format bytes to a human-readable size.
 * e.g. 1536 → "1.5 KB"
 */
export function formatBytes(bytes) {
  if (bytes == null) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const idx = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, idx);
  return `${val.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

/**
 * Format a number with locale-appropriate thousands separators.
 */
export function formatNumber(n) {
  if (n == null) return '—';
  return numeral(n).format('0,0');
}

/**
 * Truncate a string to maxLen characters, appending ellipsis if needed.
 */
export function truncate(str, maxLen = 64) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
}

/**
 * Format an absolute timestamp for tooltips.
 */
export function formatAbsolute(iso) {
  if (!iso) return '';
  try {
    return format(parseISO(iso), 'yyyy-MM-dd HH:mm:ss');
  } catch {
    return iso;
  }
}

/**
 * Convert a status code to a display label.
 */
export function statusLabel(status) {
  const labels = {
    pending:   'Pending',
    running:   'Running',
    completed: 'Completed',
    failed:    'Failed',
    cancelled: 'Cancelled',
    retrying:  'Retrying',
  };
  return labels[status] ?? status ?? 'Unknown';
}

/**
 * Determine the CSS class name for a given status.
 */
export function statusClass(status) {
  const classes = {
    pending:   'status-pending',
    running:   'status-running',
    completed: 'status-success',
    failed:    'status-error',
    cancelled: 'status-cancelled',
    retrying:  'status-warning',
  };
  return classes[status] ?? 'status-unknown';
}
