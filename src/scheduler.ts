import { loadSettings, saveSettings } from './storage';
import type { SavedSearch } from './types';

/**
 * Recurring saved-search scheduler. Uses `chrome.alarms` because it survives
 * service-worker eviction and works regardless of whether the side panel is
 * open. One alarm per scheduled search; the alarm name is the search id.
 *
 * The actual re-run is delegated back to background.ts via `onScheduledRun`,
 * which performs the scan + download (skipping already-in-library files) and
 * fires a desktop notification on new downloads if the search asked for it.
 */

const ALARM_PREFIX = 'massdl-search:';
const MIN_INTERVAL_MIN = 60; // Chrome enforces a minimum of 1 minute, but
                              // for our use case daily-ish is the floor that
                              // makes sense.

function alarmName(id: string): string {
  return ALARM_PREFIX + id;
}

function alarmIdFromName(name: string): string | null {
  return name.startsWith(ALARM_PREFIX) ? name.slice(ALARM_PREFIX.length) : null;
}

/** Reconcile chrome.alarms with the saved searches that have a schedule.
 *  Idempotent — call on SW startup and after every saved-search change. */
export async function reconcileAlarms(): Promise<void> {
  const settings = await loadSettings();
  const wanted = new Map(
    settings.savedSearches
      .filter((s) => s.schedule && s.schedule.intervalDays > 0)
      .map((s) => [alarmName(s.id), s] as const),
  );
  const existing = await chrome.alarms.getAll();

  for (const a of existing) {
    if (!a.name.startsWith(ALARM_PREFIX)) continue;
    if (!wanted.has(a.name)) {
      await chrome.alarms.clear(a.name);
    }
  }

  for (const [name, search] of wanted) {
    const intervalMin = Math.max(MIN_INTERVAL_MIN, search.schedule!.intervalDays * 24 * 60);
    const existingAlarm = existing.find((a) => a.name === name);
    // Re-create only when interval changed or alarm absent.
    if (!existingAlarm || existingAlarm.periodInMinutes !== intervalMin) {
      await chrome.alarms.clear(name);
      const delayMin = Math.min(intervalMin, 60); // first run within the hour
      await chrome.alarms.create(name, { delayInMinutes: delayMin, periodInMinutes: intervalMin });
    }
  }
}

/** Look up the saved search behind an alarm. Returns null if not a scheduler alarm. */
export async function findScheduledSearch(alarmName: string): Promise<SavedSearch | null> {
  const id = alarmIdFromName(alarmName);
  if (!id) return null;
  const settings = await loadSettings();
  return settings.savedSearches.find((s) => s.id === id && s.schedule) ?? null;
}

/** Stamp lastRunAt/nextRunAt on the search after a successful run. */
export async function recordScheduledRun(searchId: string): Promise<void> {
  const settings = await loadSettings();
  const search = settings.savedSearches.find((s) => s.id === searchId);
  if (!search?.schedule) return;
  const now = Date.now();
  search.schedule.lastRunAt = now;
  search.schedule.nextRunAt = now + search.schedule.intervalDays * 24 * 60 * 60 * 1000;
  await saveSettings(settings);
}
