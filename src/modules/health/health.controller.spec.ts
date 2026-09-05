import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import * as request from 'supertest';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { HealthController } from './health.controller';

jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn() }));

describe('HealthController HTTP readiness', () => {
  let app: INestApplication;
  let databaseUp: boolean;
  let redisUp: boolean;

  beforeAll(async () => {
    const prisma = {
      $queryRaw: jest.fn(async () => {
        if (!databaseUp) throw new Error('database unavailable');
        return [{ '?column?': 1 }];
      }),
    };

    (Redis as unknown as jest.Mock).mockImplementation(() => ({
      on: jest.fn(),
      connect: jest.fn(async () => {
        if (!redisUp) throw new Error('redis unavailable');
      }),
      ping: jest.fn(async () => 'PONG'),
      disconnect: jest.fn(),
    }));

    const moduleFixture = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => (key === 'redis.host' ? 'redis' : 6379)) },
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    databaseUp = true;
    redisUp = true;
  });

  it.each([
    { databaseUp: true, redisUp: true, expectedStatus: 200, status: 'ok' },
    { databaseUp: false, redisUp: true, expectedStatus: 503, status: 'degraded' },
    { databaseUp: true, redisUp: false, expectedStatus: 503, status: 'degraded' },
    { databaseUp: false, redisUp: false, expectedStatus: 503, status: 'degraded' },
  ])(
    'returns $expectedStatus when databaseUp=$databaseUp and redisUp=$redisUp',
    async (scenario) => {
      databaseUp = scenario.databaseUp;
      redisUp = scenario.redisUp;

      const response = await request(app.getHttpServer())
        .get('/api/v1/health/ready')
        .expect(scenario.expectedStatus);

      expect(response.body.data).toMatchObject({
        status: scenario.status,
        database: databaseUp ? 'up' : 'down',
        redis: redisUp ? 'up' : 'down',
      });
    },
  );

  it('keeps liveness independent and returns HTTP 200', async () => {
    databaseUp = false;
    redisUp = false;

    const response = await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);

    expect(response.body.data.status).toBe('ok');
  });
});
