import { describe, it, expect } from 'vitest';
import {
  validateImageAttachment,
  validateImageAttachments,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
} from './image_guard.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal valid JPEG buffer (SOI + FF E0 APP0 marker). */
function makeJpegBuffer(extraBytes = 0): Buffer {
  const magic = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const padding = Buffer.alloc(extraBytes);
  return Buffer.concat([magic, padding]);
}

/** Build a minimal valid PNG buffer (8-byte PNG signature). */
function makePngBuffer(extraBytes = 0): Buffer {
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const padding = Buffer.alloc(extraBytes);
  return Buffer.concat([magic, padding]);
}

/** Build a minimal valid GIF89a buffer. */
function makeGifBuffer(): Buffer {
  // GIF8 (4-byte prefix) + '9a' suffix
  return Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
}

/** Build a minimal valid WebP buffer (RIFF....WEBP). */
function makeWebpBuffer(): Buffer {
  return Buffer.from([
    0x52, 0x49, 0x46, 0x46, // RIFF
    0x00, 0x00, 0x00, 0x00, // file size (placeholder)
    0x57, 0x45, 0x42, 0x50, // WEBP
  ]);
}

function toBase64(buf: Buffer): string {
  return buf.toString('base64');
}

// ── validateImageAttachment ──────────────────────────────────────────────────

describe('validateImageAttachment', () => {
  describe('valid images', () => {
    it('accepts a valid JPEG', () => {
      const result = validateImageAttachment(toBase64(makeJpegBuffer()), 'image/jpeg');
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.attachment.mediaType).toBe('image/jpeg');
        expect(result.attachment.size).toBeGreaterThan(0);
      }
    });

    it('accepts a valid PNG', () => {
      const result = validateImageAttachment(toBase64(makePngBuffer()), 'image/png');
      expect(result.valid).toBe(true);
    });

    it('accepts a valid GIF', () => {
      const result = validateImageAttachment(toBase64(makeGifBuffer()), 'image/gif');
      expect(result.valid).toBe(true);
    });

    it('accepts a valid WebP', () => {
      const result = validateImageAttachment(toBase64(makeWebpBuffer()), 'image/webp');
      expect(result.valid).toBe(true);
    });

    it('strips a data-URL prefix before validating', () => {
      const base64 = toBase64(makePngBuffer());
      const withPrefix = `data:image/png;base64,${base64}`;
      const result = validateImageAttachment(withPrefix, 'image/png');
      expect(result.valid).toBe(true);
      if (result.valid) {
        // Stored data should not include the data-URL prefix
        expect(result.attachment.data).not.toContain('data:image');
      }
    });

    it('returns the correct byte size', () => {
      const buf = makePngBuffer(100);
      const result = validateImageAttachment(toBase64(buf), 'image/png');
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.attachment.size).toBe(buf.length);
      }
    });
  });

  describe('invalid MIME type', () => {
    it('rejects image/svg+xml', () => {
      const result = validateImageAttachment(toBase64(makePngBuffer()), 'image/svg+xml');
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toMatch(/unsupported image type/i);
    });

    it('rejects application/pdf', () => {
      const result = validateImageAttachment(toBase64(makePngBuffer()), 'application/pdf');
      expect(result.valid).toBe(false);
    });

    it('rejects text/plain', () => {
      const result = validateImageAttachment(toBase64(makePngBuffer()), 'text/plain');
      expect(result.valid).toBe(false);
    });
  });

  describe('invalid base64 data', () => {
    it('rejects data containing non-base64 characters', () => {
      const result = validateImageAttachment('not-valid-base64!!!', 'image/jpeg');
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toMatch(/invalid base64/i);
    });

    it('rejects empty data', () => {
      const result = validateImageAttachment('', 'image/png');
      expect(result.valid).toBe(false);
    });
  });

  describe('size limits', () => {
    it('rejects images exceeding MAX_IMAGE_BYTES', () => {
      const oversized = Buffer.concat([makePngBuffer(), Buffer.alloc(MAX_IMAGE_BYTES)]);
      const result = validateImageAttachment(toBase64(oversized), 'image/png');
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toMatch(/exceeds maximum/i);
    });

    it('accepts images exactly at the size limit', () => {
      // Build a PNG-magic-prefixed buffer that fills exactly MAX_IMAGE_BYTES bytes.
      const magic = makePngBuffer();
      const padding = Buffer.alloc(MAX_IMAGE_BYTES - magic.length);
      const exactly = Buffer.concat([magic, padding]);
      const result = validateImageAttachment(toBase64(exactly), 'image/png');
      expect(result.valid).toBe(true);
    });
  });

  describe('magic-byte spoofing prevention', () => {
    it('rejects PNG data declared as image/jpeg', () => {
      const result = validateImageAttachment(toBase64(makePngBuffer()), 'image/jpeg');
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toMatch(/does not match declared type/i);
    });

    it('rejects JPEG data declared as image/png', () => {
      const result = validateImageAttachment(toBase64(makeJpegBuffer()), 'image/png');
      expect(result.valid).toBe(false);
    });

    it('rejects arbitrary bytes declared as image/gif', () => {
      const garbage = Buffer.from('this is not a gif');
      const result = validateImageAttachment(toBase64(garbage), 'image/gif');
      expect(result.valid).toBe(false);
    });
  });
});

// ── validateImageAttachments (batch) ─────────────────────────────────────────

describe('validateImageAttachments', () => {
  it('accepts an empty list', () => {
    const result = validateImageAttachments([]);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.attachments).toHaveLength(0);
  });

  it('accepts multiple valid images', () => {
    const inputs = [
      { data: toBase64(makeJpegBuffer()), mediaType: 'image/jpeg' },
      { data: toBase64(makePngBuffer()), mediaType: 'image/png' },
    ];
    const result = validateImageAttachments(inputs);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.attachments).toHaveLength(2);
  });

  it(`rejects more than ${MAX_IMAGES_PER_MESSAGE} images`, () => {
    const inputs = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => ({
      data: toBase64(makeJpegBuffer()),
      mediaType: 'image/jpeg',
    }));
    const result = validateImageAttachments(inputs);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toMatch(/too many images/i);
  });

  it('reports the index of the first failing image', () => {
    const inputs = [
      { data: toBase64(makeJpegBuffer()), mediaType: 'image/jpeg' }, // valid
      { data: 'bad!!!data', mediaType: 'image/png' },                // invalid
    ];
    const result = validateImageAttachments(inputs);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toMatch(/image 2/i);
  });

  it('fails fast on the first invalid image', () => {
    const inputs = [
      { data: 'bad!!!data', mediaType: 'image/png' },               // invalid (first)
      { data: toBase64(makeJpegBuffer()), mediaType: 'image/jpeg' }, // valid (second)
    ];
    const result = validateImageAttachments(inputs);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toMatch(/image 1/i);
  });
});
