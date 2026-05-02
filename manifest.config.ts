import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'MassDownload',
  version: '0.1.1',
  description:
    'Mass-download files (PDF, etc.) from Google search results across all pages, or from any page with links.',
  permissions: ['sidePanel', 'downloads', 'activeTab', 'scripting', 'storage', 'offscreen', 'tabs'],
  host_permissions: ['<all_urls>'],
  action: {
    default_title: 'MassDownload — open side panel',
  },
  side_panel: {
    default_path: 'src/sidepanel/sidepanel.html',
  },
  background: {
    service_worker: 'src/background.ts',
    type: 'module',
  },
  web_accessible_resources: [
    {
      resources: ['src/offscreen.html'],
      matches: ['<all_urls>'],
    },
  ],
});
