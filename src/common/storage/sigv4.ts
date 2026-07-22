import { createHash, createHmac } from 'crypto';

/**
 * 21_ADRs > ADR-087. Pure AWS Signature Version 4 (query-string /
 * presigned-URL variant) implementation — no NestJS, no config, no I/O.
 * Deliberately factored out of `StorageService` so each stage of the
 * algorithm (URI encoding, canonical request, string-to-sign, signing key
 * derivation) is independently unit-testable against AWS's own published
 * worked example, not just the final opaque signature — hand-rolled crypto
 * is exactly the kind of code where "the final output looks like a hex
 * string" is not enough confidence on its own.
 *
 * Reference: docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
 * MinIO implements the identical scheme (S3-API-compatible by design), so
 * this same code presigns correctly against both a self-hosted MinIO
 * container and real AWS S3.
 */

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

export interface PresignInput {
  method: 'GET' | 'PUT';
  host: string;
  /** Already includes the bucket segment for path-style, or not, for virtual-hosted — see `StorageService.presign`. */
  canonicalUri: string;
  expiresInSeconds: number;
  /** Injectable for deterministic tests; defaults to `new Date()` in real use. */
  now?: Date;
  useSsl: boolean;
}

/**
 * AWS "UriEncode" per the SigV4 spec — percent-encode every byte except
 * unreserved characters (A-Za-z0-9-_.~); `/` is preserved when
 * `encodeSlash` is false (canonical-URI path segments — bucket/key), and
 * fully encoded otherwise (query keys/values, where AWS requires strict
 * encoding of every reserved character including `/`).
 */
export function uriEncode(input: string, encodeSlash: boolean): string {
  let result = '';
  for (const ch of input) {
    if (/[A-Za-z0-9\-_.~]/.test(ch)) {
      result += ch;
    } else if (ch === '/' && !encodeSlash) {
      result += ch;
    } else {
      for (const byte of Buffer.from(ch, 'utf8')) {
        result += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
      }
    }
  }
  return result;
}

/** ISO 8601 basic format: `YYYYMMDDTHHMMSSZ` (strips `-`, `:`, and millis from `Date#toISOString`). */
export function toAmzDate(d: Date): string {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

export function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

export function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

export function buildCanonicalQueryString(params: Array<[string, string]>): string {
  return params
    .map(([k, v]) => [uriEncode(k, true), uriEncode(v, true)] as [string, string])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

export function buildCanonicalRequest(params: {
  method: 'GET' | 'PUT';
  canonicalUri: string;
  canonicalQueryString: string;
  host: string;
}): string {
  return [
    params.method,
    params.canonicalUri,
    params.canonicalQueryString,
    `host:${params.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
}

export function buildStringToSign(params: {
  amzDate: string;
  credentialScope: string;
  canonicalRequest: string;
}): string {
  return [
    'AWS4-HMAC-SHA256',
    params.amzDate,
    params.credentialScope,
    sha256Hex(params.canonicalRequest),
  ].join('\n');
}

/** kSecret -> kDate -> kRegion -> kService -> kSigning, per the SigV4 spec's own derivation chain. */
export function deriveSigningKey(secretAccessKey: string, dateStamp: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
}

/**
 * Full presign: builds the query string, canonical request, string-to-sign,
 * derives the signing key, and returns the complete signed URL. `now`
 * defaults to `new Date()` — overridable so tests can reproduce AWS's own
 * published worked example byte-for-byte.
 */
export function presignUrl(input: PresignInput, creds: SigV4Credentials): string {
  const now = input.now ?? new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const region = creds.region || 'us-east-1';
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const credential = `${creds.accessKeyId}/${credentialScope}`;

  const canonicalQueryString = buildCanonicalQueryString([
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', credential],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(input.expiresInSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ]);

  const canonicalRequest = buildCanonicalRequest({
    method: input.method,
    canonicalUri: input.canonicalUri,
    canonicalQueryString,
    host: input.host,
  });

  const stringToSign = buildStringToSign({ amzDate, credentialScope, canonicalRequest });

  const signingKey = deriveSigningKey(creds.secretAccessKey, dateStamp, region);
  const signature = hmac(signingKey, stringToSign).toString('hex');

  const scheme = input.useSsl ? 'https' : 'http';
  return `${scheme}://${input.host}${input.canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}
