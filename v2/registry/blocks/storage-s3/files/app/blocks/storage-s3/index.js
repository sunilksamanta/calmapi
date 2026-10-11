import { definePlugin } from '#calm';
import { settings } from './s3.js';

export default definePlugin({
  name: 'storage-s3',
  setup(calm) {
    calm.doctor(() => {
      const s = settings();
      const findings = [];
      if (!s.bucket) findings.push({ level: 'error', id: 's3-bucket', title: 'S3_BUCKET is not set', detail: 'Uploads cannot work without a bucket. Set S3_BUCKET (and S3_ENDPOINT for R2/MinIO).' });
      if (!process.env.S3_ACCESS_KEY_ID && calm.config.mode !== 'production') {
        findings.push({ level: 'info', id: 's3-credentials', title: 'No S3_ACCESS_KEY_ID set', detail: 'The AWS default credential chain will be used (IAM role, profile or AWS_* env vars).' });
      }
      return findings;
    });
    calm.devtools.panel('storage', () => {
      const s = settings();
      return { driver: 's3', bucket: s.bucket ?? '(not set)', region: s.region, endpoint: s.endpoint ?? 'AWS', maxMb: s.maxBytes / 1048576, allowedTypes: s.allowed };
    });
  },
});
