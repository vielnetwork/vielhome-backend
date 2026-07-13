/**
 * Error taxonomy per 08_API_Architecture (AIHandoff V2).
 *
 * Every error the API returns must be one of these types. Domain/Application
 * layers throw these instead of framework-specific HttpExceptions, so
 * business logic stays framework-agnostic (11_Backend_Architecture).
 */

export type AppErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTHORIZATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'BUSINESS_RULE_VIOLATION'
  | 'DUPLICATE'
  | 'RATE_LIMIT'
  | 'UNEXPECTED_ERROR';

export abstract class AppError extends Error {
  abstract readonly code: AppErrorCode;
  abstract readonly httpStatus: number;

  constructor(
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  readonly code: AppErrorCode = 'VALIDATION_ERROR';
  readonly httpStatus = 400;
}

export class AuthorizationError extends AppError {
  readonly code: AppErrorCode = 'AUTHORIZATION_ERROR';
  readonly httpStatus = 403;
}

export class NotFoundAppError extends AppError {
  readonly code: AppErrorCode = 'NOT_FOUND';
  readonly httpStatus = 404;
}

export class ConflictError extends AppError {
  readonly code: AppErrorCode = 'CONFLICT';
  readonly httpStatus = 409;
}

/**
 * Thrown whenever implementation would otherwise violate a rule from
 * 05_Business_Rules. Never bypass this to "make it work" — fix the rule
 * or fix the caller, per Principle 3 (Business Rules Before Code).
 */
export class BusinessRuleViolationError extends AppError {
  readonly code: AppErrorCode = 'BUSINESS_RULE_VIOLATION';
  readonly httpStatus = 422;
}

export class DuplicateError extends AppError {
  readonly code: AppErrorCode = 'DUPLICATE';
  readonly httpStatus = 409;
}

export class RateLimitError extends AppError {
  readonly code: AppErrorCode = 'RATE_LIMIT';
  readonly httpStatus = 429;
}

export class UnexpectedAppError extends AppError {
  readonly code: AppErrorCode = 'UNEXPECTED_ERROR';
  readonly httpStatus = 500;
}
