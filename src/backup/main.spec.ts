import { main } from './main';
import { readBackupConfig } from './backup.config';
import { operate } from './backup.operations';
jest.mock('./backup.config');
jest.mock('./backup.operations');
jest.mock('@prisma/client', () => ({ PrismaClient: jest.fn(() => ({ $disconnect: jest.fn() })) }));
describe('structured completion contract', () => {
  let output: jest.SpyInstance;
  beforeEach(() => {
    output = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    output.mockRestore();
    process.exitCode = 0;
  });
  it.each([0, 1])('reports deterministic completion with exit %s', async (exitCode) => {
    jest
      .mocked(readBackupConfig)
      .mockReturnValue({ mode: 'metrics', databaseUrl: 'unused' } as any);
    jest.mocked(operate).mockResolvedValue({ exitCode, summary: { unprotectedCount: 0 } } as any);
    await main(['metrics']);
    const events = output.mock.calls.map(([line]) => JSON.parse(line));
    expect(events[0].event).toBe('backup.started');
    expect(events[1]).toMatchObject({
      event: 'backup.completed',
      runId: events[0].runId,
      exitCode,
      outcome: exitCode ? 'unhealthy' : 'healthy',
    });
    expect(process.exitCode).toBe(exitCode);
  });
  it('configuration failures emit nonsecret unhealthy completion and exit two', async () => {
    jest.mocked(readBackupConfig).mockImplementation(() => {
      throw new Error('SENSITIVE_SENTINEL');
    });
    await main(['run']);
    expect(process.exitCode).toBe(2);
    expect(JSON.stringify(output.mock.calls)).not.toContain('SENSITIVE_SENTINEL');
    expect(JSON.parse(output.mock.calls[1][0])).toMatchObject({
      outcome: 'unhealthy',
      exitCode: 2,
    });
  });
});
