/**
 * Login/register validation — detailed 400 field errors.
 *
 * Covers: parseRegisterFieldErrors maps server first-issue texts to the
 * right field (email / password / firstName), and the page source wires
 * FieldError + aria-invalid under every input (contract: no generic
 * "Unexpected error" for 400, 409 email_taken stays in the top Alert).
 */
import { describe, expect, test } from 'bun:test';
import { parseRegisterFieldErrors } from '../../../src/lib/register-field-errors';
import { loginSchema, registerSchema } from '../../../src/lib/auth-schemas';

describe('parseRegisterFieldErrors', () => {
  test('maps invalid email to the email field', () => {
    expect(parseRegisterFieldErrors('must be a valid email')).toEqual({
      email: 'must be a valid email',
    });
  });

  test('maps short password to the password field', () => {
    expect(parseRegisterFieldErrors('must be at least 8 characters')).toEqual({
      password: 'must be at least 8 characters',
    });
  });

  test('maps empty name to the firstName field (fallback)', () => {
    expect(parseRegisterFieldErrors('must not be empty')).toEqual({
      firstName: 'must not be empty',
    });
  });

  test('maps too-long name to the firstName field', () => {
    expect(parseRegisterFieldErrors('must be ≤ 100 chars')).toEqual({
      firstName: 'must be ≤ 100 chars',
    });
  });
});

describe('auth-schemas (client zod, before submit)', () => {
  test('empty register fields fail with per-field issues', () => {
    const result = registerSchema.safeParse({ email: '', password: '', firstName: '', lastName: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((i) => String(i.path[0]));
      expect(fields).toContain('email');
      expect(fields).toContain('password');
      expect(fields).toContain('firstName');
      expect(fields).toContain('lastName');
    }
  });

  test('invalid email fails on the email field (login + register)', () => {
    const login = loginSchema.safeParse({ email: 'not-an-email', password: 'password123' });
    expect(login.success).toBe(false);
    if (!login.success) {
      expect(String(login.error.issues[0]?.path[0])).toBe('email');
    }
    const register = registerSchema.safeParse({
      email: 'not-an-email',
      password: 'password123',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    expect(register.success).toBe(false);
    if (!register.success) {
      expect(register.error.issues.map((i) => String(i.path[0]))).toContain('email');
    }
  });

  test('short password fails on the password field', () => {
    const result = loginSchema.safeParse({ email: 'name@example.com', password: 'short' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(String(result.error.issues[0]?.path[0])).toBe('password');
    }
  });

  test('valid input passes and trims names', () => {
    const result = registerSchema.safeParse({
      email: 'name@example.com',
      password: 'password123',
      firstName: '  Ada  ',
      lastName: 'Lovelace',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.firstName).toBe('Ada');
    }
  });
});

describe('login page 400 wiring (source contract)', () => {
  const loadSource = () =>
    Bun.file(new URL('./page.tsx', import.meta.url).pathname).text();

  test('keeps fieldErrors state and 400 branch', async () => {
    const source = await loadSource();
    expect(source).toContain('fieldErrors');
    expect(source).toContain('err.status === 400');
    expect(source).toContain('parseRegisterFieldErrors');
  });

  test('renders FieldError under each field with aria-invalid', async () => {
    const source = await loadSource();
    expect(source).toContain('<FieldError>{fieldErrors.email}</FieldError>');
    expect(source).toContain('<FieldError>{fieldErrors.password}</FieldError>');
    expect(source).toContain('<FieldError>{fieldErrors.firstName}</FieldError>');
    expect(source).toContain('aria-invalid');
  });

  test('keeps 409 emailTaken in the top Alert', async () => {
    const source = await loadSource();
    expect(source).toContain("err.code === 'email_taken'");
    expect(source).toContain('t.validation.emailTaken');
  });

  test('dev defaults removed, neutral placeholders, client zod before submit', async () => {
    const source = await loadSource();
    expect(source).not.toContain('dev@devbox.local');
    expect(source).not.toContain('password123');
    expect(source).toContain("useState('')");
    expect(source).toContain('name@example.com');
    expect(source).toContain('At least 8 characters');
    expect(source).toContain('registerSchema.safeParse');
    // Server 400/409 mapping stays as fallback after the client check.
    expect(source).toContain('parseRegisterFieldErrors');
    expect(source).toContain("err.code === 'email_taken'");
  });

  test('useLogin validates via zod instead of manual checks', async () => {
    const source = await Bun.file(
      new URL('../../../src/hooks/useLogin.ts', import.meta.url).pathname,
    ).text();
    expect(source).toContain('loginSchema.safeParse');
    expect(source).not.toContain("includes('@')");
    expect(source).not.toContain('password.length < 8');
  });
  test('shows diagnosticId with short correlationId and Copy', async () => {
    const source = await loadSource();
    expect(source).toContain('t.errors.diagnosticId');
    expect(source).toContain('correlationId.slice(0, 8)');
    expect(source).toContain('console.error');
    // console.error carries only code + correlationId (no secrets).
    const logLines = source
      .split('\n')
      .filter((l) => l.includes('console.error'))
      .join('\n');
    expect(logLines).not.toContain('password');
    expect(logLines).not.toContain('token');
  });
});
