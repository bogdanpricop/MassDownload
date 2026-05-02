import { canonicalizeUrl } from './parsers/filters';
import type { LinkInfo, SearchSource } from './types';

/**
 * Persisted snapshot of an in-progress download queue. Survives service worker
 * eviction. The user can resume on the next side panel open.
 *
 * Storage key: `queueState`. Cleared when the queue completes or is stopped.
 */
export interface PersistedQueue {
  /** All items that were originally enqueued. */
  items: LinkInfo[];
  /** Canonical URLs of items already finished (ok / failed / skipped). */
  completedIds: string[];
  maxParallel: number;
  subfolderPattern: string;
  query?: string;
  source: SearchSource | 'tab' | 'generic';
  preflightCheck?: boolean;
  /** Unix ms when the queue was started — surfaces stale state to the user. */
  startedAt: number;
}

const KEY = 'queueState';

export async function loadQueueState(): Promise<PersistedQueue | null> {
  const result = await chrome.storage.local.get(KEY);
  return (result[KEY] as PersistedQueue | undefined) ?? null;
}

export async function saveQueueState(q: PersistedQueue): Promise<void> {
  await chrome.storage.local.set({ [KEY]: q });
}

export async function clearQueueState(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}

/** Compute the items that still need to run (originally enqueued − completed). */
export function pendingItems(q: PersistedQueue): LinkInfo[] {
  if (q.completedIds.length === 0) return q.items;
  const done = new Set(q.completedIds);
  return q.items.filter((it) => {
    const id = canonicalizeUrl(it.url);
    return id ? !done.has(id) : true;
  });
}
