import { definePlugin } from '#calm';
import { settings } from './storage.js';

// Local file storage. The 'file' resource (app/resources/file) holds the metadata;
// this plugin only reports its configuration to doctor and devtools.
export default definePlugin({
  name: 'storage-local',
  env: {
    UPLOAD_DIR: 'Folder for uploaded files (default ./uploads)',
    UPLOAD_MAX_MB: 'Largest upload in MB (default 10)',
    UPLOAD_ALLOWED_TYPES: 'Comma separated MIME types (default: images and PDF)',
  },
  setup(calm) {
    calm.doctor(() => {
      const findings = [];
      if (calm.config.mode === 'production') {
        findings.push({
          level: 'info',
          id: 'storage-local-production',
          title: 'Uploads are stored on local disk',
          detail: `Files live in ${settings().dir}. With several instances or ephemeral disks use @calmapi/storage-s3.`,
        });
      }
      return findings;
    });
    calm.devtools.panel('storage', () => {
      const s = settings();
      return { driver: 'local disk', directory: s.dir, maxMb: s.maxBytes / 1048576, allowedTypes: s.allowed };
    });
  },
});
