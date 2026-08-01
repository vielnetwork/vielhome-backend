import { ConfigService } from '@nestjs/config';
import { MaintenanceModeMiddleware } from './maintenance-mode.middleware';
import { MaintenanceModeService } from '../../modules/maintenance/application/maintenance-mode.service';
import type { AppConfig } from '../../config/configuration';

function makeConfig(): ConfigService<AppConfig, true> {
  return {
    get: (key: string) => (key === 'apiPrefix' ? 'api' : undefined),
  } as unknown as ConfigService<AppConfig, true>;
}

function makeMaintenanceMode(enabled: boolean): MaintenanceModeService {
  return { isEnabled: jest.fn().mockReturnValue(enabled) } as unknown as MaintenanceModeService;
}

function makeReqRes(path: string, requestId = 'req-1') {
  const req = { path, requestId } as unknown as Parameters<MaintenanceModeMiddleware['use']>[0];
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const res = { status } as unknown as Parameters<MaintenanceModeMiddleware['use']>[1];
  const next = jest.fn();
  return { req, res, next, status, json };
}

describe('MaintenanceModeMiddleware', () => {
  it('passes every request through when maintenance mode is disabled', () => {
    const middleware = new MaintenanceModeMiddleware(makeMaintenanceMode(false), makeConfig());
    const { req, res, next, status } = makeReqRes('/api/v1/backoffice/monitoring/overview');

    middleware.use(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });

  describe('when maintenance mode is enabled', () => {
    const middleware = () => new MaintenanceModeMiddleware(makeMaintenanceMode(true), makeConfig());

    it.each([
      '/api/v1/health',
      '/api/v1/health/live',
      '/api/v1/health/ready',
      '/api/v1/auth/otp/request',
      '/api/v1/auth/token/refresh',
      '/api/v1/backoffice/maintenance-mode',
    ])('still passes exempt path %s through', (path) => {
      const { req, res, next, status } = makeReqRes(path);

      middleware().use(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(status).not.toHaveBeenCalled();
    });

    it('blocks a non-exempt path with a 503 and the standard error envelope', () => {
      const { req, res, next, status, json } = makeReqRes('/api/v1/backoffice/monitoring/overview');

      middleware().use(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(503);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          requestId: 'req-1',
          errors: [expect.objectContaining({ code: 'SERVICE_UNAVAILABLE' })],
        }),
      );
    });

    it('never leaks anything beyond the sanitized message on block', () => {
      const { req, res, next, json } = makeReqRes('/api/v1/profile');

      middleware().use(req, res, next);

      const body = json.mock.calls[0][0];
      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/postgres(ql)?:\/\//i);
      expect(serialized).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/);
    });

    it('falls back to "unknown" requestId if RequestContextMiddleware somehow did not run first', () => {
      const { req, res, next, json } = makeReqRes(
        '/api/v1/backoffice/monitoring/overview',
        undefined as unknown as string,
      );

      middleware().use(req, res, next);

      expect(json).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'unknown' }));
    });

    it('does not treat an unrelated path that merely starts with the same characters as exempt', () => {
      // "/api/v1/authorization-audit" must NOT match the "/api/v1/auth" exempt prefix.
      const { req, res, next, status } = makeReqRes('/api/v1/authorization-audit');

      middleware().use(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(503);
    });
  });
});
