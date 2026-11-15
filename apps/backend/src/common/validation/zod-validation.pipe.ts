import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

/** Shape of a single Standard Schema issue (message only is consumed here). */
type SchemaIssue = { message?: string };

type StandardSchema = {
  readonly '~standard': {
    validate: (
      value: unknown,
    ) =>
      | { issues?: Array<SchemaIssue> }
      | Promise<{ issues?: Array<SchemaIssue> }>;
  };
};

/** Minimal structural view of a schema: zod `safeParse` and/or Standard Schema. */
type ValidatableSchema = {
  safeParse?: (value: unknown) => ParseResult;
  '~standard'?: StandardSchema['~standard'];
};

type ParseResult = {
  success: boolean;
  data?: unknown;
  error?: { issues?: Array<SchemaIssue> };
};

type ValidateResult = { issues?: Array<SchemaIssue> };

/**
 * Zod@4 ValidationPipe with first-class Standard Schema support.
 *
 * Accepts either a Zod schema (safeParse) or any Standard Schema
 * (`~standard.validate`) — Nest 12 style. On failure throws
 * BadRequestException; ApiErrorFilter renders the { code, message,
 * correlationId } envelope.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: unknown) {}

  async transform(value: unknown): Promise<unknown> {
    const schema: ValidatableSchema = this.schema as ValidatableSchema;

    // Native Zod path (zod@4 safeParse).
    if (typeof schema?.safeParse === 'function') {
      const parsed: ParseResult = schema.safeParse(value);
      if (parsed.success) return parsed.data;
      const first: string =
        parsed.error?.issues?.[0]?.message ?? 'Validation failed';
      throw new BadRequestException(first);
    }

    // Standard Schema path (Nest 12 first-class support).
    if (schema?.['~standard'] && typeof schema['~standard'].validate === 'function') {
      const result: ValidateResult = await schema['~standard'].validate(value);
      if (!result || !result.issues || result.issues.length === 0) return value;
      throw new BadRequestException(result.issues[0]?.message ?? 'Validation failed');
    }

    return value;
  }
}
