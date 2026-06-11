import { Request, RequestHandler } from 'express';
import { z } from 'zod';

/** Wrap an async handler so thrown/rejected errors reach the error middleware. */
export function asyncHandler(
  fn: (req: Request, res: import('express').Response, next: import('express').NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** Simple HTTP error with a status code, mapped to JSON by the error handler. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ');
}

// Generic over the schema (not its output) so zod's resolved output type —
// including `.default()` and `.coerce` — is preserved for callers.
export function parseBody<S extends z.ZodTypeAny>(schema: S, req: Request): z.infer<S> {
  const result = schema.safeParse(req.body);
  if (!result.success) throw new HttpError(400, formatIssues(result.error));
  return result.data;
}

export function parseQuery<S extends z.ZodTypeAny>(schema: S, req: Request): z.infer<S> {
  const result = schema.safeParse(req.query);
  if (!result.success) throw new HttpError(400, formatIssues(result.error));
  return result.data;
}
