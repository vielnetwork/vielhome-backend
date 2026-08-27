/**
 * FIN-REC-01B — real file-signature ("magic byte") detection. Used only by
 * the payment-receipt finalize path (`PaymentReceiptService`, via
 * `StorageService.readObjectPrefix`) to catch a text file renamed
 * `.jpg`/`.png`/`.pdf` before a `Document`/`DocumentVersion` row is ever
 * created for it. Deliberately NOT wired into the generic Documents
 * CREATE_DOCUMENT/CREATE_VERSION finalize call sites
 * (`DocumentsService.resolveUploadIntent`) — `StorageService.verifyObjectUploaded`'s
 * own doc comment already discloses Content-Type/content verification as
 * unimplemented there, and extending it needs its own regression coverage
 * this pass doesn't include; kept receipt-only on purpose, not an
 * oversight.
 *
 * A pure function, no I/O, no DI — the actual bytes come from
 * `StorageService.readObjectPrefix`'s ranged GET.
 */
export type DetectedFileSignature = 'PDF' | 'PNG' | 'JPEG';

const SIGNATURES: ReadonlyArray<{ type: DetectedFileSignature; bytes: readonly number[] }> = [
  { type: 'PDF', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // "%PDF-"
  { type: 'PNG', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: 'JPEG', bytes: [0xff, 0xd8, 0xff] },
];

/** Returns the real file type detected from the leading bytes, or `null` if none of the supported signatures match. */
export function detectFileSignature(bytes: Uint8Array): DetectedFileSignature | null {
  for (const signature of SIGNATURES) {
    if (bytes.length < signature.bytes.length) continue;
    if (signature.bytes.every((expected, index) => bytes[index] === expected)) {
      return signature.type;
    }
  }
  return null;
}

/**
 * Maps this domain's business-level `fileType` vocabulary (PDF/JPG/JPEG/PNG
 * — see `DocumentPolicy`'s own `SUPPORTED_FILE_TYPES`) onto the real
 * signatures above. JPG and JPEG are the same signature/format, just two
 * spellings of the same declared type.
 */
export function normalizeDeclaredFileType(fileType: string): DetectedFileSignature | null {
  const upper = fileType.toUpperCase();
  if (upper === 'PDF') return 'PDF';
  if (upper === 'PNG') return 'PNG';
  if (upper === 'JPG' || upper === 'JPEG') return 'JPEG';
  return null;
}
