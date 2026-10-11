import { z } from 'zod';

/**
 * Project-name validation — mirrors backend min/max (1..200) but adds
 * charset restriction + UX-aware trimming.
 *
 * Разрешённые символы:
 *  - буквы латиницы и кириллицы (A-Za-z, А-Яа-яЁё)
 *  - цифры 0-9
 *  - пробел, дефис -, подчёркивание _, точка .
 * Всё остальное (< > / \ | : * ? " ' ` ! @ # $ % ^ & * () + = { } [ ] ; , …) — запрещено.
 * Логика:
 *  - trim() по краям (пустое после trim — ошибка required)
 *  - 2..100 символов после trim (UX: не 1 символ, не слишком длинное)
 *  - должны быть только разрешённые символы
 *  - должен содержать хотя бы одну букву или цифру (не только "-_ .")
 */
const PROJECT_NAME_ALLOWED_RE = /^[A-Za-zА-Яа-яЁё0-9 _\-.]+$/;
const PROJECT_NAME_HAS_ALNUM_RE = /[A-Za-zА-Яа-яЁё0-9]/;

export const createProjectSchema = z.object({
  name: z
    .string({ error: 'project_name_required' })
    .trim()
    .min(1, { error: 'project_name_required' })
    .min(2, { error: 'project_name_too_short' })
    .max(100, { error: 'project_name_too_long' })
    .regex(PROJECT_NAME_ALLOWED_RE, { error: 'project_name_invalid_chars' })
    .refine((v) => PROJECT_NAME_HAS_ALNUM_RE.test(v), {
      error: 'project_name_invalid_chars',
    }),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

/**
 * Shared constants for UI hints / tests.
 */
export const PROJECT_NAME_MIN = 2;
export const PROJECT_NAME_MAX = 100;
export const PROJECT_NAME_PATTERN_HINT = 'A-Za-z А-Яа-я 0-9 _ - .';
