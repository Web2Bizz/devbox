'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Field,
  FieldError,
  FieldLabel,
  Input,
} from '@web2bizz/ui/components';
import { ApiClientError, api } from '@/api/client';
import { parseRegisterFieldErrors } from '@/lib/register-field-errors';
import { loginSchema, registerSchema, type LoginInput, type RegisterInput } from '@/lib/auth-schemas';
import { setSession } from '@/lib/auth-store';
import { formatApiError } from '@/lib/format-error';
import { useI18n } from '@/i18n';

function LoginForm({ onSuccess }: { onSuccess: () => void }) {
  const { t } = useI18n();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isValid },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    mode: 'onChange',
    defaultValues: { email: '', password: '' },
  });

  const mutation = useMutation({
    mutationFn: (data: LoginInput) => api.login({ email: data.email.trim(), password: data.password }),
    onSuccess: (session) => {
      setSession(session);
      onSuccess();
    },
    onError: (e: unknown) => {
      if (e instanceof ApiClientError && e.code === 'invalid_credentials') {
        setError('root', { message: t.validation.invalidCredentials });
      } else {
        const msg = formatApiError(e);
        setError('root', { message: msg === 'Unexpected error' ? t.errors.unexpected : msg });
      }
    },
  });

  return (
    <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="grid gap-6">
      <CardContent className="grid gap-4">
        {errors.root && (
          <Alert variant="destructive">
            <AlertTitle>{t.auth.loginFailed}</AlertTitle>
            <AlertDescription>{errors.root.message}</AlertDescription>
          </Alert>
        )}
        <Field>
          <FieldLabel htmlFor="login-email">{t.auth.email}</FieldLabel>
          <Input id="login-email" type="email" autoComplete="email" placeholder="name@example.com" className="bg-background" aria-invalid={!!errors.email} {...register('email')} />
          {errors.email && <FieldError>{t.validation.invalidEmailDetailed}</FieldError>}
        </Field>
        <Field>
          <FieldLabel htmlFor="login-password">{t.auth.password}</FieldLabel>
          <Input id="login-password" type="password" autoComplete="current-password" placeholder="At least 8 characters" className="bg-background" aria-invalid={!!errors.password} {...register('password')} />
          {errors.password && <FieldError>{t.validation.passwordMin}</FieldError>}
        </Field>
      </CardContent>
      <CardFooter className="grid gap-3">
        <Button type="submit" variant="primaryBrand" disabled={!isValid || mutation.isPending} className="w-full">
          {mutation.isPending ? t.auth.signingIn : t.auth.signIn}
        </Button>
      </CardFooter>
    </form>
  );
}

function RegisterForm({ onSuccess }: { onSuccess: () => void }) {
  const { t } = useI18n();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isValid },
  } = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    mode: 'onChange',
    defaultValues: { email: '', password: '', firstName: '', lastName: '' },
  });

  const mutation = useMutation({
    mutationFn: (data: RegisterInput) =>
      api.register({ firstName: data.firstName, lastName: data.lastName, email: data.email.trim(), password: data.password }),
    onSuccess: (session) => {
      setSession(session);
      onSuccess();
    },
    onError: (e: unknown) => {
      if (!(e instanceof ApiClientError)) {
        setError('root', { message: t.errors.unexpected });
        return;
      }
      if (e.code === 'email_taken') {
        setError('root', { message: t.validation.emailTaken });
        return;
      }
      if (e.status === 400) {
        const fields = parseRegisterFieldErrors(e.message);
        (Object.entries(fields) as [keyof RegisterInput, string][]).forEach(([k, msg]) => setError(k, { message: msg }));
        if (Object.keys(fields).length === 0) setError('root', { message: e.message });
        return;
      }
      setError('root', { message: e.status >= 500 ? t.errors.somethingWentWrong : t.errors.unexpected });
    },
  });

  return (
    <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="grid gap-6">
      <CardContent className="grid gap-4">
        {errors.root && (
          <Alert variant="destructive">
            <AlertTitle>{t.auth.registerFailed}</AlertTitle>
            <AlertDescription>{errors.root.message}</AlertDescription>
          </Alert>
        )}
        <Field>
          <FieldLabel htmlFor="reg-firstName">{t.auth.firstName}</FieldLabel>
          <Input id="reg-firstName" autoComplete="given-name" placeholder="Ada" className="bg-background" aria-invalid={!!errors.firstName} {...register('firstName')} />
          {errors.firstName && <FieldError>{t.validation.nameRequired}</FieldError>}
        </Field>
        <Field>
          <FieldLabel htmlFor="reg-lastName">{t.auth.lastName}</FieldLabel>
          <Input id="reg-lastName" autoComplete="family-name" placeholder="Lovelace" className="bg-background" aria-invalid={!!errors.lastName} {...register('lastName')} />
          {errors.lastName && <FieldError>{t.validation.nameRequired}</FieldError>}
        </Field>
        <Field>
          <FieldLabel htmlFor="reg-email">{t.auth.email}</FieldLabel>
          <Input id="reg-email" type="email" autoComplete="email" placeholder="name@example.com" className="bg-background" aria-invalid={!!errors.email} {...register('email')} />
          {errors.email && <FieldError>{errors.email.message ?? t.validation.invalidEmailDetailed}</FieldError>}
        </Field>
        <Field>
          <FieldLabel htmlFor="reg-password">{t.auth.password}</FieldLabel>
          <Input id="reg-password" type="password" autoComplete="new-password" placeholder="At least 8 characters" className="bg-background" aria-invalid={!!errors.password} {...register('password')} />
          {errors.password && <FieldError>{errors.password.message ?? t.validation.passwordMin}</FieldError>}
        </Field>
      </CardContent>
      <CardFooter className="grid gap-3">
        <Button type="submit" variant="primaryBrand" disabled={!isValid || mutation.isPending} className="w-full">
          {mutation.isPending ? t.auth.signingUp : t.auth.signUp}
        </Button>
      </CardFooter>
    </form>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  // Единый onSuccess для LoginForm и RegisterForm: setSession уже синхронно
  // проштамповал клиентский `rush-code-auth` (см. setAuthMarker), поэтому guard
  // proxy.ts (`rush-code-auth=1`) пропустит /projects без bounce в /login.
  // Раньше был голый router.push: маркер ставил только backend Set-Cookie,
  // который на кросс-портовом dev (:3001 → :3000, SameSite=Lax) остаётся на
  // origin'е API — proxy маркера не видел и отбивал /projects → /login.
  // replace (без записи /login в history) + refresh (перепрогон guard'а со
  // свежей кукой); если router кинул — полный переход через location.
  const onSuccess = () => {
    try {
      router.replace('/projects');
      router.refresh();
    } catch {
      window.location.assign('/projects');
    }
  };

  return (
    <Card variant="brand">
      <CardHeader className="text-center">
        <CardTitle className="text-center">{mode === 'login' ? t.auth.welcomeBack : t.auth.signUp}</CardTitle>
        <CardDescription className="text-center">{mode === 'login' ? t.auth.subtitle : t.auth.createAccount}</CardDescription>
      </CardHeader>
      {mode === 'login' ? <LoginForm onSuccess={onSuccess} /> : <RegisterForm onSuccess={onSuccess} />}
      <div className="px-6 pb-6">
        <p className="text-muted-foreground text-center text-sm">
          <button type="button" className="underline" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? t.auth.noAccount : t.auth.haveAccount}
          </button>
        </p>
      </div>
    </Card>
  );
}
