import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

/**
 * Zod@4 ValidationPipe with first-class Standard Schema support.
 *
 * Accepts either a Zod schema (safeParse) or any Standard Schema
 * (`~standard.validate`) — Nest 12 style. On failure throws
 * BadRequestException; ApiErrorFilter renders the { code, message,
 * correlationId } envelope.
 */
type StandardSchema = {
  readonly '~standard': {
    validate: (value: unknown) => { issues?: Array<{ message?: string }> } | Promise<{
      issues?: Array<{ message?: string }>;
    }>;
  };
};

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: unknown) {}

  async transform(value: unknown): Promise<unknown> {
    const schema = this.schema as {
      safeParse?: (v: unknown) => { success: boolean; data?: unknown; error?: { issues?: Array<{ message?: string }> } };
      '~standard'?: StandardSchema['~standard'];
    };

    // Native Zod path (zod@4 safeParse).
    if (typeof schema?.safeParse === 'function') {
      const parsed = schema.safeParse(value);
      if (parsed.success) return parsed.data;
      const first = parsed.error?.issues?.[0]?.message ?? 'Validation failed';
      throw new BadRequestException(first);
    }

    // Standard Schema path (Nest 12 first-class support).
    if (schema?.['~standard'] && typeof schema['~standard'].validate === 'function') {
      const result = await schema['~standard'].validate(value);
      if (!result || !result.issues || result.issues.length === 0) return value;
      throw new BadRequestException(result.issues[0]?.message ?? 'Validation failed');
    }

    return value;
  }
}
