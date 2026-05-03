import { defineManifest } from '@crxjs/vite-plugin';

// `process` exists at Vite-config time (Node), but the TS types target the
// extension runtime — keep a defensive guard rather than pulling in @types/node.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const isFirefox = env.MASSDL_TARGET === 'firefox';

const baseManifest = {
  manifest_version: 3 as const,
  name: 'MassDownload',
  version: '0.3.1',
  description:
    'Mass-download files (PDF, etc.) from Google search results across all pages, or from any page with links.',
  host_permissions: ['<all_urls>'],
  action: {
    default_title: 'MassDownload — open side panel',
  },
  web_accessible_resources: [
    {
      resources: ['src/offscreen.html', 'src/library/page.html'],
      matches: ['<all_urls>'],
    },
  ],
};

// Chrome / Edge build (default) — uses chrome.sidePanel + chrome.offscreen.
const chromeManifest = {
  ...baseManifest,
  permissions: [
    'sidePanel',
    'downloads',
    'activeTab',
    'scripting',
    'storage',
    'offscreen',
    'tabs',
    'alarms',
    'notifications',
  ],
  side_panel: {
    default_path: 'src/sidepanel/sidepanel.html',
  },
  background: {
    service_worker: 'src/background.ts',
    type: 'module' as const,
  },
};

// Firefox build (experimental) — sidePanel + offscreen don't exist on Firefox.
// We use sidebar_action (Firefox's equivalent of side panel) and rely on the
// DOMParser fallback in the SW (Firefox supports it natively, unlike Chromium).
const firefoxManifest = {
  ...baseManifest,
  permissions: [
    'downloads',
    'activeTab',
    'scripting',
    'storage',
    'tabs',
    'alarms',
    'notifications',
  ],
  sidebar_action: {
    default_panel: 'src/sidepanel/sidepanel.html',
    default_title: 'MassDownload',
  },
  background: {
    // Firefox MV3 supports both event pages and service workers, but service
    // workers are less battle-tested. Prefer the event-page form.
    scripts: ['src/background.ts'],
    type: 'module' as const,
  },
  browser_specific_settings: {
    gecko: {
      id: 'massdownload@bogdanpricop',
      strict_min_version: '128.0',
    },
  },
};

export default defineManifest(isFirefox ? (firefoxManifest as never) : chromeManifest);
