import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// S3 (or any S3-compatible store) with presigned URLs: file bytes never pass
// through your API servers. Objects are private; downloads use short-lived URLs.

export const settings = () => ({
  bucket: process.env.S3_BUCKET,
  region: process.env.S3_REGION || 'us-east-1',
  endpoint: process.env.S3_ENDPOINT || undefined,
  maxBytes: Number(process.env.UPLOAD_MAX_MB || 10) * 1024 * 1024,
  allowed: (process.env.UPLOAD_ALLOWED_TYPES || 'image/png,image/jpeg,image/gif,image/webp,application/pdf').split(',').map((s) => s.trim()),
  uploadTtl: 600,
  downloadTtl: 300,
});

let client;
export function s3() {
  const s = settings();
  client ??= new S3Client({
    region: s.region,
    endpoint: s.endpoint,
    forcePathStyle: Boolean(s.endpoint),
    credentials: process.env.S3_ACCESS_KEY_ID
      ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY }
      : undefined, // fall back to the default AWS credential chain (IAM roles, env, profiles)
  });
  return client;
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf' };

export const newKey = (ownerId, contentType) => {
  const d = new Date();
  return `uploads/${ownerId}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${EXT[contentType] ?? 'bin'}`;
};

export async function presignUpload(key, contentType, size) {
  const s = settings();
  const command = new PutObjectCommand({ Bucket: s.bucket, Key: key, ContentType: contentType, ContentLength: size });
  const url = await getSignedUrl(s3(), command, { expiresIn: s.uploadTtl, signableHeaders: new Set(['content-type', 'content-length']) });
  return { url, method: 'PUT', headers: { 'Content-Type': contentType }, expiresIn: s.uploadTtl };
}

export async function head(key) {
  try {
    return await s3().send(new HeadObjectCommand({ Bucket: settings().bucket, Key: key }));
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return null;
    throw err;
  }
}

export async function presignDownload(key, fileName, inline) {
  const s = settings();
  const command = new GetObjectCommand({
    Bucket: s.bucket,
    Key: key,
    ResponseContentDisposition: `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  });
  return getSignedUrl(s3(), command, { expiresIn: s.downloadTtl });
}

export const remove = (key) => s3().send(new DeleteObjectCommand({ Bucket: settings().bucket, Key: key }));
