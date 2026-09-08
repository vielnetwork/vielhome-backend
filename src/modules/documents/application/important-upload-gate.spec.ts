import { assertImportantUploadsAllowed } from './important-upload-gate';
import { DocumentsService } from './documents.service';
import { PaymentReceiptService } from './payment-receipt.service';
import { DocumentRepository } from '../infrastructure/repositories/document.repository';

describe('server-side important-upload gate', () => {
  const previous = process.env.VH_IMPORTANT_UPLOADS_BLOCKED;
  afterEach(() => {
    if (previous === undefined) delete process.env.VH_IMPORTANT_UPLOADS_BLOCKED;
    else process.env.VH_IMPORTANT_UPLOADS_BLOCKED = previous;
  });
  it('unset and explicit false preserve open behavior', () => {
    expect(() => assertImportantUploadsAllowed({})).not.toThrow();
    expect(() =>
      assertImportantUploadsAllowed({ VH_IMPORTANT_UPLOADS_BLOCKED: 'false' }),
    ).not.toThrow();
  });
  it.each(['true', 'TRUE', '1', 'invalid', ''])('configured value %s fails closed', (value) => {
    expect(() => assertImportantUploadsAllowed({ VH_IMPORTANT_UPLOADS_BLOCKED: value })).toThrow();
  });
  it.each(['requestUploadUrl', 'createDocument', 'bulkCreateDocuments', 'uploadVersion'])(
    '%s is blocked before any service IO',
    async (method) => {
      process.env.VH_IMPORTANT_UPLOADS_BLOCKED = 'true';
      const service: any = Object.create(DocumentsService.prototype);
      await expect(service[method]()).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        httpStatus: 503,
      });
    },
  );
  it.each(['requestUploadIntent', 'finalize'])(
    'receipt %s is blocked before IO',
    async (method) => {
      process.env.VH_IMPORTANT_UPLOADS_BLOCKED = 'true';
      const service: any = Object.create(PaymentReceiptService.prototype);
      await expect(service[method]()).rejects.toMatchObject({ httpStatus: 503 });
    },
  );
  it.each(['createDocumentWithFirstVersion', 'addVersion', 'createPaymentReceipt'])(
    'repository %s checks the gate inside its transaction',
    async (method) => {
      process.env.VH_IMPORTANT_UPLOADS_BLOCKED = 'true';
      const tx = {};
      const db: any = { $transaction: (fn: any) => fn(tx) };
      const repo: any = new DocumentRepository(db);
      await expect(repo[method]({})).rejects.toMatchObject({ httpStatus: 503 });
    },
  );
});
