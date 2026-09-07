import { HttpBackupStorage } from './backup.storage';
const source = {
  endpoint: 'https://source.invalid',
  bucket: 'test-source',
  accessKeyId: 'synthetic-source',
  secretAccessKey: 'synthetic-secret',
};
const dest = {
  ...source,
  endpoint: 'https://destination.invalid',
  bucket: 'test-dest',
  accessKeyId: 'synthetic-dest',
};
describe('separate storage clients', () => {
  it('uses source for conditional reads, destination for conditional creates, and never DELETE', async () => {
    const transport = jest.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const s = new HttpBackupStorage(source, dest, 64, transport);
    await s.readSource('documents/key', '"etag"');
    await s.putNew('objects/capture', Buffer.from('x'));
    expect(new URL(transport.mock.calls[0][0]).hostname).toBe('source.invalid');
    expect(transport.mock.calls[0][1].headers).toEqual({ 'If-Match': '"etag"' });
    expect(new URL(transport.mock.calls[1][0]).hostname).toBe('destination.invalid');
    expect(transport.mock.calls[1][1].headers['If-None-Match']).toBe('*');
  });
  it('sanitizes transport errors that might contain signed URLs', async () => {
    const s = new HttpBackupStorage(
      source,
      dest,
      64,
      jest.fn().mockRejectedValue(new Error('signed-secret-url')),
    );
    await expect(s.readSource('key', 'e')).rejects.toThrow('STORAGE_UNAVAILABLE');
  });
  it('bounds downloaded bytes even without Content-Length', async () => {
    const s = new HttpBackupStorage(
      source,
      dest,
      1,
      jest.fn().mockResolvedValue(new Response('oversized')),
    );
    await expect(s.readSource('key', 'e')).rejects.toThrow('OBJECT_TOO_LARGE');
  });
  it('rejects duplicate generation instead of overwriting it', async () => {
    const s = new HttpBackupStorage(
      source,
      dest,
      64,
      jest.fn().mockResolvedValue(new Response(null, { status: 412 })),
    );
    await expect(s.putNew('key', Buffer.from('x'))).rejects.toThrow('GENERATION_EXISTS');
  });
});
