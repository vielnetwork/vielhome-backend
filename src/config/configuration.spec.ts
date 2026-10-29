import configuration from './configuration';

describe('notification provider configuration', () => {
  const original = process.env;

  beforeEach(() => {
    process.env = { ...original };
    delete process.env.KAVENEGAR_API_KEY;
    delete process.env.KAVENEGAR_VERIFY_TEMPLATE;
  });

  afterAll(() => {
    process.env = original;
  });

  it('reads Kavenegar OTP settings independently from Twilio settings', () => {
    process.env.KAVENEGAR_API_KEY = 'test-api-key';
    process.env.KAVENEGAR_VERIFY_TEMPLATE = 'vielhome-verify';
    process.env.DATABASE_URL = 'postgresql://test';

    const config = configuration();

    expect(config.notificationProviders.sms).toMatchObject({
      kavenegarApiKey: 'test-api-key',
      kavenegarVerifyTemplate: 'vielhome-verify',
      accountSid: '',
      authToken: '',
      fromNumber: '',
    });
  });

  it('defaults Kavenegar OTP settings to unconfigured without secrets', () => {
    process.env.DATABASE_URL = 'postgresql://test';
    expect(configuration().notificationProviders.sms).toMatchObject({
      kavenegarApiKey: '',
      kavenegarVerifyTemplate: '',
    });
  });
});
