import { ServiceUnavailableError } from '../../../common/errors/app-error';

/** Explicit operational gate; invalid configured values fail closed. */
export function assertImportantUploadsAllowed(env: NodeJS.ProcessEnv = process.env): void {
  const value = env.VH_IMPORTANT_UPLOADS_BLOCKED;
  if (value === undefined || value === 'false') return;
  throw new ServiceUnavailableError('Document and receipt uploads are temporarily unavailable.');
}
