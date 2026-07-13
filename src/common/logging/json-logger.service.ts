import { ConsoleLogger, LoggerService, LogLevel } from '@nestjs/common';

/**
 * 21_ADRs > ADR-064 — minimal structured (JSON-lines) logger, replacing
 * Nest's default pretty-printed console output in production only.
 * Deliberately zero new npm dependencies (no pino/winston): this sandbox
 * has never had npm registry access to verify a new package resolves and
 * behaves correctly (unchanged since ADR-022/Sprint 3.9), so a hand-written
 * `LoggerService` using only Nest/Node built-ins is the lowest-risk way to
 * give production log aggregation (24_Release_Readiness_Audit_v1.0 > 3.2 —
 * "no structured logging") something machine-parseable to ingest, without
 * adding an unverified dependency. A real structured-logging library
 * (pino is `19_Current_Sprint`'s own "Planned addition") remains a
 * reasonable future upgrade once the user's own local `npm install` can
 * verify it — this is intentionally NOT presented as a replacement for
 * that, only as a safe, zero-dependency interim step.
 *
 * In development/test (`NODE_ENV !== 'production'`), delegates to Nest's
 * own `ConsoleLogger` unchanged — only production gets JSON lines, so the
 * familiar, readable local dev console output is untouched.
 */
export class JsonLoggerService implements LoggerService {
  private readonly isProduction = (process.env.NODE_ENV ?? 'development') === 'production';
  private readonly devLogger = new ConsoleLogger();

  log(message: unknown, context?: string): void {
    this.write('log', message, context);
  }

  error(message: unknown, trace?: string, context?: string): void {
    this.write('error', message, context, trace);
  }

  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.write('verbose', message, context);
  }

  private write(level: LogLevel, message: unknown, context?: string, trace?: string): void {
    if (!this.isProduction) {
      const fn = this.devLogger[level] as ((msg: unknown, ctx?: string) => void) | undefined;
      fn?.call(this.devLogger, message, context);
      return;
    }

    const line: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      context: context ?? 'Application',
      message: typeof message === 'string' ? message : JSON.stringify(message),
    };
    if (trace) {
      line.trace = trace;
    }
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(line));
  }
}
