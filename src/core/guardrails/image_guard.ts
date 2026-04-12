/**
 * Safe image input guardrail.
 *
 * Validates image attachments before they enter the message pipeline to prevent
 * oversized payloads, unsupported formats, and malformed base64 data from
 * reaching the LLM or being stored in the database.
 */

export type SafeImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

/** Validated, safe image attachment ready for downstream processing. */
export interface ImageAttachment {
  mediaType: SafeImageMediaType;
  /** Raw base64-encoded image data (no data-URL prefix). */
  data: string;
  /** Decoded byte size. */
  size: number;
}

export type ImageValidationResult =
  | { valid: true; attachment: ImageAttachment }
  | { valid: false; error: string };

/** Maximum allowed byte size per image (5 MB). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Maximum number of images allowed per message. */
export const MAX_IMAGES_PER_MESSAGE = 5;

const ALLOWED_MEDIA_TYPES: ReadonlySet<string> = new Set<SafeImageMediaType>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

/** Expected magic-byte prefixes for each allowed MIME type (in decoded bytes). */
const MAGIC_BYTES: Array<{ mediaType: SafeImageMediaType; bytes: number[] }> = [
  { mediaType: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mediaType: 'image/png',  bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mediaType: 'image/gif',  bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF8
  { mediaType: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF (WebP)
];

/**
 * Strip a data-URL prefix (e.g. "data:image/png;base64,") if present.
 * Returns the raw base64 string.
 */
function stripDataUrlPrefix(raw: string): string {
  const match = raw.match(/^data:[^;]+;base64,(.+)$/s);
  return match ? match[1] : raw;
}

/**
 * Validate that `base64` decodes to valid bytes for the declared `mediaType`.
 * Checks magic bytes so the declared MIME type cannot be spoofed.
 */
function validateMagicBytes(buf: Buffer, mediaType: SafeImageMediaType): boolean {
  const entry = MAGIC_BYTES.find((m) => m.mediaType === mediaType);
  if (!entry) return false;
  if (buf.length < entry.bytes.length) return false;
  return entry.bytes.every((b, i) => buf[i] === b);
}

/**
 * Validate a single image attachment.
 *
 * @param rawData   Base64-encoded image data (with or without a data-URL prefix).
 * @param mediaType The declared MIME type supplied by the caller.
 */
export function validateImageAttachment(rawData: string, mediaType: string): ImageValidationResult {
  // 1. Check declared MIME type is in the allow-list.
  if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
    return { valid: false, error: `Unsupported image type: ${mediaType}. Allowed types: jpeg, png, gif, webp` };
  }

  // 2. Strip data-URL prefix if present.
  const base64 = stripDataUrlPrefix(rawData).trim();

  // 3. Validate base64 encoding — must only contain valid base64 characters.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    return { valid: false, error: 'Image data contains invalid base64 characters' };
  }

  // 4. Decode and check size.
  let buf: Buffer;
  try {
    buf = Buffer.from(base64, 'base64');
  } catch {
    return { valid: false, error: 'Image data could not be decoded' };
  }

  if (buf.length === 0) {
    return { valid: false, error: 'Image data is empty' };
  }

  if (buf.length > MAX_IMAGE_BYTES) {
    return {
      valid: false,
      error: `Image exceeds maximum allowed size of ${MAX_IMAGE_BYTES / (1024 * 1024)} MB`,
    };
  }

  // 5. Verify magic bytes match the declared MIME type to prevent type spoofing.
  if (!validateMagicBytes(buf, mediaType as SafeImageMediaType)) {
    return { valid: false, error: `Image data does not match declared type ${mediaType}` };
  }

  return {
    valid: true,
    attachment: {
      mediaType: mediaType as SafeImageMediaType,
      data: base64,
      size: buf.length,
    },
  };
}

/**
 * Validate a batch of image attachments from a single message.
 * Returns `{ valid: true, attachments }` only when every attachment passes,
 * or `{ valid: false, error }` describing the first failure.
 */
export function validateImageAttachments(
  inputs: Array<{ data: string; mediaType: string }>,
): { valid: true; attachments: ImageAttachment[] } | { valid: false; error: string } {
  if (inputs.length > MAX_IMAGES_PER_MESSAGE) {
    return {
      valid: false,
      error: `Too many images: maximum ${MAX_IMAGES_PER_MESSAGE} images per message`,
    };
  }

  const attachments: ImageAttachment[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const result = validateImageAttachment(inputs[i].data, inputs[i].mediaType);
    if (!result.valid) {
      return { valid: false, error: `Image ${i + 1}: ${result.error}` };
    }
    attachments.push(result.attachment);
  }

  return { valid: true, attachments };
}
