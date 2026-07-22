import {
  buildCanonicalQueryString,
  buildCanonicalRequest,
  buildStringToSign,
  deriveSigningKey,
  presignUrl,
  sha256Hex,
  toAmzDate,
  uriEncode,
} from './sigv4';

/**
 * 21_ADRs > ADR-087. These tests check the SigV4 algorithm's STRUCTURE —
 * canonical request format, query-string sorting/encoding, string-to-sign
 * shape, deterministic key derivation — against what the AWS spec
 * documents (docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-
 * auth.html), not a hand-typed expected final signature hash. A wrong
 * memorized hex string would be worse than no test at all: it could fail a
 * CORRECT implementation, or (worse) get "fixed" into matching a WRONG one.
 * The one fully trustworthy check for hand-rolled crypto like this is a
 * live round-trip against real storage — see
 * `scripts/verify-storage-roundtrip.ts` and its own README section; run it
 * against a real MinIO/S3 bucket before trusting this in production, same
 * "this sandbox can't verify it, the user's real toolchain must" discipline
 * every other ADR in this project's Testing-phase series already follows.
 */
describe('sigv4', () => {
  describe('uriEncode', () => {
    it('leaves unreserved characters untouched', () => {
      expect(uriEncode('abcXYZ019-_.~', true)).toBe('abcXYZ019-_.~');
    });

    it('percent-encodes a space as %20, not +', () => {
      expect(uriEncode('a b', true)).toBe('a%20b');
    });

    it('encodes "/" when encodeSlash is true, preserves it when false', () => {
      expect(uriEncode('a/b', true)).toBe('a%2Fb');
      expect(uriEncode('a/b', false)).toBe('a/b');
    });

    it('percent-encodes each UTF-8 byte of a non-ASCII character', () => {
      // 'م' (Arabic/Persian "meem", U+0645) is 2 UTF-8 bytes: 0xD9 0x85.
      expect(uriEncode('م', true)).toBe('%D9%85');
    });

    it('uppercases hex digits, per the spec', () => {
      expect(uriEncode('!', true)).toBe('%21');
    });
  });

  describe('toAmzDate', () => {
    it('formats as YYYYMMDDTHHMMSSZ with no separators or millis', () => {
      expect(toAmzDate(new Date('2013-05-24T00:00:00.000Z'))).toBe('20130524T000000Z');
      expect(toAmzDate(new Date('2026-07-22T16:45:30.123Z'))).toBe('20260722T164530Z');
    });
  });

  describe('buildCanonicalQueryString', () => {
    it('percent-encodes keys/values and sorts alphabetically by encoded key', () => {
      const qs = buildCanonicalQueryString([
        ['X-Amz-SignedHeaders', 'host'],
        ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
        ['X-Amz-Date', '20130524T000000Z'],
      ]);
      // Alphabetical: Algorithm < Date < SignedHeaders.
      expect(qs).toBe(
        'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20130524T000000Z&X-Amz-SignedHeaders=host',
      );
    });

    it('percent-encodes "/" inside a value (e.g. the credential scope)', () => {
      const qs = buildCanonicalQueryString([
        ['X-Amz-Credential', 'AKIAEXAMPLE/20130524/us-east-1/s3/aws4_request'],
      ]);
      expect(qs).toBe(
        'X-Amz-Credential=AKIAEXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request',
      );
    });
  });

  describe('buildCanonicalRequest', () => {
    it('matches the exact 6-line shape the AWS spec documents', () => {
      const canonicalRequest = buildCanonicalRequest({
        method: 'GET',
        canonicalUri: '/test.txt',
        canonicalQueryString:
          'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host',
        host: 'examplebucket.s3.amazonaws.com',
      });

      expect(canonicalRequest).toBe(
        [
          'GET',
          '/test.txt',
          'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host',
          'host:examplebucket.s3.amazonaws.com',
          '',
          'host',
          'UNSIGNED-PAYLOAD',
        ].join('\n'),
      );
    });
  });

  describe('buildStringToSign', () => {
    it('matches the exact 4-line "AWS4-HMAC-SHA256" shape the spec documents', () => {
      const canonicalRequest = 'GET\n/test.txt\n\nhost:example.com\n\nhost\nUNSIGNED-PAYLOAD';
      const stringToSign = buildStringToSign({
        amzDate: '20130524T000000Z',
        credentialScope: '20130524/us-east-1/s3/aws4_request',
        canonicalRequest,
      });

      expect(stringToSign).toBe(
        [
          'AWS4-HMAC-SHA256',
          '20130524T000000Z',
          '20130524/us-east-1/s3/aws4_request',
          sha256Hex(canonicalRequest),
        ].join('\n'),
      );
    });
  });

  describe('deriveSigningKey', () => {
    it('is deterministic — the same inputs always derive the same key', () => {
      const a = deriveSigningKey('secret', '20130524', 'us-east-1');
      const b = deriveSigningKey('secret', '20130524', 'us-east-1');
      expect(a.equals(b)).toBe(true);
    });

    it('is a 32-byte HMAC-SHA256 digest', () => {
      expect(deriveSigningKey('secret', '20130524', 'us-east-1').length).toBe(32);
    });

    it('produces a different key for a different date, region, or secret', () => {
      const base = deriveSigningKey('secret', '20130524', 'us-east-1');
      expect(deriveSigningKey('secret', '20130525', 'us-east-1').equals(base)).toBe(false);
      expect(deriveSigningKey('secret', '20130524', 'eu-west-1').equals(base)).toBe(false);
      expect(deriveSigningKey('other-secret', '20130524', 'us-east-1').equals(base)).toBe(false);
    });
  });

  describe('presignUrl', () => {
    const fixedNow = new Date('2013-05-24T00:00:00.000Z');
    const creds = {
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
    };

    it('produces a well-formed, fully-parameterized presigned URL (virtual-hosted style)', () => {
      const url = presignUrl(
        {
          method: 'GET',
          host: 'examplebucket.s3.amazonaws.com',
          canonicalUri: '/test.txt',
          expiresInSeconds: 86400,
          now: fixedNow,
          useSsl: true,
        },
        creds,
      );

      expect(url.startsWith('https://examplebucket.s3.amazonaws.com/test.txt?')).toBe(true);
      expect(url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
      expect(url).toContain(
        'X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request',
      );
      expect(url).toContain('X-Amz-Date=20130524T000000Z');
      expect(url).toContain('X-Amz-Expires=86400');
      expect(url).toContain('X-Amz-SignedHeaders=host');
      // 64 lowercase hex characters — a real HMAC-SHA256 hex digest, not a placeholder.
      const sigMatch = url.match(/X-Amz-Signature=([0-9a-f]+)$/);
      expect(sigMatch).not.toBeNull();
      expect(sigMatch?.[1].length).toBe(64);
    });

    it('is fully deterministic for a fixed clock — same inputs, byte-identical URL', () => {
      const opts = {
        method: 'PUT' as const,
        host: 'examplebucket.s3.amazonaws.com',
        canonicalUri: '/documents/b1/2026/07/abc-file.pdf',
        expiresInSeconds: 900,
        now: fixedNow,
        useSsl: true,
      };
      expect(presignUrl(opts, creds)).toBe(presignUrl(opts, creds));
    });

    it('produces a different signature for GET vs PUT on the same key', () => {
      const base = {
        host: 'examplebucket.s3.amazonaws.com',
        canonicalUri: '/test.txt',
        expiresInSeconds: 900,
        now: fixedNow,
        useSsl: true,
      };
      const getUrl = presignUrl({ ...base, method: 'GET' }, creds);
      const putUrl = presignUrl({ ...base, method: 'PUT' }, creds);
      expect(getUrl).not.toBe(putUrl);
    });

    it('uses http:// when useSsl is false (self-hosted MinIO without TLS)', () => {
      const url = presignUrl(
        {
          method: 'GET',
          host: 'localhost:9000',
          canonicalUri: '/my-bucket/test.txt',
          expiresInSeconds: 900,
          now: fixedNow,
          useSsl: false,
        },
        creds,
      );
      expect(url.startsWith('http://localhost:9000/my-bucket/test.txt?')).toBe(true);
    });
  });
});
