import { IsBase64, IsIn, IsString, Matches } from 'class-validator';
import { AppError } from './errors';

export const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const;
export type UploadType = (typeof UPLOAD_TYPES)[number];

export class UploadDto {
  @IsString() @Matches(/^[\w .()-]{1,120}$/, { message: 'fileName has invalid characters' }) fileName: string;
  @IsIn(UPLOAD_TYPES) contentType: UploadType;
  @IsBase64() dataBase64: string;
}

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAGIC: Record<UploadType, (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'application/pdf': (b) => b.subarray(0, 5).toString() === '%PDF-',
};
export const EXT: Record<UploadType, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };

/** Base64 → bytes, 5 MB cap, type checked by magic bytes (the declared type is not trusted). */
export function decodeUpload(dataBase64: string, contentType: UploadType) {
  const body = Buffer.from(dataBase64, 'base64');
  if (body.byteLength > MAX_UPLOAD_BYTES) throw new AppError(413, 'FILE_TOO_LARGE', 'At most 5 MB');
  if (!MAGIC[contentType]?.(body)) throw new AppError(400, 'FILE_TYPE_MISMATCH', `The file is not a valid ${contentType}`);
  return body;
}

/** The shape POST /mobile/uploads mints: `<tenant>/<user>/<uuid>.<ext>`. */
const UPLOAD_KEY = /^([\w-]+)\/([\w-]+)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|pdf)$/;

/** Is this an upload key of that tenant (and, when given, minted by that user)? A prefix test is not enough: `../` escapes it. */
export function isUploadKey(key: string, tenantId: string, userId?: string) {
  const m = UPLOAD_KEY.exec(key);
  return !!m && m[1] === tenantId && (userId === undefined || m[2] === userId);
}

/**
 * Storage paths reach the service-role client unencoded and fetch resolves `.`/`..` segments, so a crafted
 * key could sign an object in another bucket. Rejects dot or empty segments and characters that re-route a URL.
 */
export const isSafeStorageKey = (key: string) =>
  !/[\%?#]/.test(key) && key.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
