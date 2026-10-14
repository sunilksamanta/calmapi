import { mkdirSync, openSync, readSync, closeSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import { badRequest } from '#calm';

// Local disk storage. Files get random names (never the uploaded name), the declared
// type must be on the allowlist, and the first bytes must match that type.

export const settings = () => ({
  dir: resolve(process.env.UPLOAD_DIR || './uploads'),
  maxBytes: Number(process.env.UPLOAD_MAX_MB || 10) * 1024 * 1024,
  allowed: (process.env.UPLOAD_ALLOWED_TYPES || 'image/png,image/jpeg,image/gif,image/webp,application/pdf').split(',').map((s) => s.trim()),
});

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf', 'text/plain': 'txt', 'text/csv': 'csv' };

// Magic numbers for types we can verify. Others are accepted on the declared type alone.
const SIGNATURES = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
};

/** Types safe to display inline in a browser. Everything else downloads as an attachment. */
export const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function uploadMiddleware(field = 'file') {
  const { dir, maxBytes, allowed } = settings();
  mkdirSync(dir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: dir,
      filename: (_req, file, cb) => cb(null, `${randomUUID()}.${EXT[file.mimetype] ?? 'bin'}`),
    }),
    limits: { fileSize: maxBytes, files: 1, fields: 10 },
    fileFilter: (_req, file, cb) => {
      if (!allowed.includes(file.mimetype)) return cb(badRequest(`File type ${file.mimetype} is not allowed. Allowed: ${allowed.join(', ')}`));
      cb(null, true);
    },
  }).single(field);

  return (req, res, next) =>
    upload(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') return next(badRequest(`File is larger than ${Math.round(maxBytes / 1048576)} MB`));
      if (err.name === 'MulterError') return next(badRequest(err.message));
      next(err);
    });
}

/** Verify the stored bytes match the declared type; deletes the file when they do not. */
export function verifySignature(file) {
  const check = SIGNATURES[file.mimetype];
  if (!check) return;
  const fd = openSync(file.path, 'r');
  const head = Buffer.alloc(16);
  readSync(fd, head, 0, 16, 0);
  closeSync(fd);
  if (!check(head)) {
    remove(file.filename);
    throw badRequest(`File content does not match ${file.mimetype}`);
  }
}

export const pathOf = (key) => join(settings().dir, key.replace(/[^\w.-]/g, ''));

export function remove(key) {
  const path = pathOf(key);
  if (existsSync(path)) unlinkSync(path);
}
