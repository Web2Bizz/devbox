import { z } from "zod";

/** Шаблон идентификатора агента без спецсимволов */
export const agentIdPattern: RegExp = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** Шаблон имени инструмента без спецсимволов */
export const toolNamePattern: RegExp = /^[A-Za-z0-9_.-]+$/;
/** Шаблон имени модели без спецсимволов */
export const modelNamePattern: RegExp = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
/** Шаблон значения effort без спецсимволов */
export const effortValuePattern: RegExp = /^[a-z0-9][a-z0-9_-]*$/i;
/** Шаблон имени агента без спецсимволов */
export const agentNamePattern: RegExp = /^[\p{L}\p{N} _.-]+$/u;

/** Роль отправителя сообщения диалога модели */
export const agentRoleSchema: z.ZodEnum<{
  system: "system";
  user: "user";
  assistant: "assistant";
}> = z.enum(["system", "user", "assistant"]);

/** Сообщение диалога для модели генерации */
export const agentMessageSchema: z.ZodObject<{
  role: z.ZodEnum<{
    system: "system";
    user: "user";
    assistant: "assistant";
  }>;
  content: z.ZodString;
}> = z.object({
  /** Роль отправителя этого сообщения диалога */
  role: agentRoleSchema,
  /** Текст содержимого этого сообщения диалога */
  content: z.string({ error: "Field content is required" }).min(1).max(8000),
});

/** Тип сообщения выведенный из схемы */
export type AgentMessage = z.infer<typeof agentMessageSchema>;

/** Опции создания нового экземпляра агента */
export const agentBaseOptionsSchema: z.ZodObject<{
  id: z.ZodString;
  name: z.ZodString;
  description: z.ZodString;
  systemPrompt: z.ZodString;
  allowedTools: z.ZodOptional<z.ZodReadonly<z.ZodArray<z.ZodString>>>;
  deniedTools: z.ZodOptional<z.ZodReadonly<z.ZodArray<z.ZodString>>>;
  models: z.ZodReadonly<z.ZodArray<z.ZodString>>;
  model: z.ZodOptional<z.ZodString>;
  effort: z.ZodOptional<z.ZodReadonly<z.ZodArray<z.ZodString>>>;
}> = z
  .object({
    /** Уникальный идентификатор агента для реестра */
    id: z
      .string({ error: "Field id is required" })
      .min(1)
      .max(64)
      .regex(agentIdPattern, { error: "Field id has forbidden characters" }),
    /** Уникальное имя агента в системе */
    name: z
      .string({ error: "Field name is required" })
      .min(1)
      .max(100)
      .regex(agentNamePattern, { error: "Field name has forbidden characters" }),
    /** Краткое описание возможностей данного агента */
    description: z
      .string({ error: "Field description is required" })
      .min(1)
      .max(500),
    /** Системный промпт задающий поведение агента */
    systemPrompt: z
      .string({ error: "Field systemPrompt is required" })
      .min(1)
      .max(8000),
    /** Разрешённые инструменты доступные для вызова */
    allowedTools: z
      .array(
        z.string().min(1).max(64).regex(toolNamePattern, {
          error: "Tool name has forbidden characters",
        }),
      )
      .readonly()
      .optional(),
    /** Запрещённые инструменты недоступные для вызова */
    deniedTools: z
      .array(
        z.string().min(1).max(64).regex(toolNamePattern, {
          error: "Tool name has forbidden characters",
        }),
      )
      .readonly()
      .optional(),
    /** Поддерживаемые модели доступные для запуска */
    models: z
      .array(
        z.string().min(1).max(100).regex(modelNamePattern, {
          error: "Model name has forbidden characters",
        }),
      )
      .min(1)
      .readonly(),
    /** Текущая модель выбранная для генерации */
    model: z
      .string()
      .min(1)
      .max(100)
      .regex(modelNamePattern, { error: "Model name has forbidden characters" })
      .optional(),
    /** Допустимые уровни effort для модели */
    effort: z
      .array(
        z.string().min(1).max(32).regex(effortValuePattern, {
          error: "Effort value has forbidden characters",
        }),
      )
      .readonly()
      .optional(),
  })
  // type: contextual — zod's own `superRefine` callback types (`output<this>`
  // and `$RefinementCtx<output<this>>`) cannot be restated by an explicit
  // annotation while the schema const itself is still being declared.
  .superRefine((options, context) => {
    const model: string | undefined = options.model ?? options.models[0];
    if (model && !options.models.includes(model)) {
      context.addIssue({
        code: "custom",
        message: `Model '${model}' is not supported`,
        path: ["model"],
      });
    }
    const allowed: ReadonlyArray<string> = options.allowedTools ?? [];
    const denied: ReadonlyArray<string> = options.deniedTools ?? [];
    const conflict: Array<string> = allowed.filter((tool) => denied.includes(tool));
    if (conflict.length > 0) {
      context.addIssue({
        code: "custom",
        message: `Tools denied and allowed: ${conflict.join(", ")}`,
        path: ["deniedTools"],
      });
    }
  });

/** Тип опций выведенный из схемы */
export type AgentBaseOptions = z.infer<typeof agentBaseOptionsSchema>;

/** Параметры одного вызова агента */
export const agentCallOptionsSchema: z.ZodObject<{
  messages: z.ZodOptional<z.ZodReadonly<z.ZodArray<typeof agentMessageSchema>>>;
  model: z.ZodOptional<z.ZodString>;
  effort: z.ZodOptional<z.ZodString>;
}> = z.object({
  /** История диалога для этого вызова */
  messages: z.array(agentMessageSchema).max(100).readonly().optional(),
  /** Модель для этого вызова */
  model: z
    .string()
    .min(1)
    .max(100)
    .regex(modelNamePattern, { error: "Model name has forbidden characters" })
    .optional(),
  /** Effort для этого вызова */
  effort: z
    .string()
    .min(1)
    .max(32)
    .regex(effortValuePattern, { error: "Effort value has forbidden characters" })
    .optional(),
});

/** Тип параметров вызова выведенный */
export type AgentCallOptions = z.infer<typeof agentCallOptionsSchema>;

/** Общий предок всех конкретных агентов */
export abstract class AgentBase {
  /** Уникальный идентификатор агента для реестра */
  readonly id: string;
  /** Уникальное имя агента в системе */
  readonly name: string;
  /** Краткое описание возможностей данного агента */
  readonly description: string;
  /** Системный промпт задающий поведение агента */
  readonly systemPrompt: string;
  /** Разрешённые инструменты доступные для вызова */
  readonly allowedTools: ReadonlyArray<string>;
  /** Запрещённые инструменты недоступные для вызова */
  readonly deniedTools: ReadonlyArray<string>;
  /** Поддерживаемые модели доступные для запуска */
  readonly models: ReadonlyArray<string>;
  /** Допустимые уровни effort для модели */
  readonly effort?: ReadonlyArray<string>;
  /** Модель по умолчанию для генерации */
  readonly defaultModel: string;
  /** Effort по умолчанию для генерации */
  readonly defaultEffort?: string;

  /** Создаёт агента из заданных опций */
  protected constructor(options: AgentBaseOptions) {
    const parsed: AgentBaseOptions = agentBaseOptionsSchema.parse(options);
    this.id = parsed.id;
    this.name = parsed.name;
    this.description = parsed.description;
    this.systemPrompt = parsed.systemPrompt;
    this.allowedTools = [...(parsed.allowedTools ?? [])];
    this.deniedTools = [...(parsed.deniedTools ?? [])];
    this.models = [...parsed.models];
    this.defaultModel = parsed.model ?? parsed.models[0];
    this.effort = parsed.effort ? [...parsed.effort] : undefined;
    this.defaultEffort = this.effort?.[0];
  }

  /** Проверяет доступность инструмента данному агенту */
  canUseTool(tool: string): boolean {
    if (!toolNamePattern.test(tool)) {
      return false;
    }
    if (this.deniedTools.includes(tool)) {
      return false;
    }
    if (this.allowedTools.length === 0) {
      return true;
    }
    return this.allowedTools.includes(tool);
  }

  /** Проверяет модель для этого вызова */
  protected resolveModel(override?: string): string {
    const model: string = override ?? this.defaultModel;
    if (!modelNamePattern.test(model)) {
      throw new Error(`Model '${model}' has forbidden characters`);
    }
    if (!this.models.includes(model)) {
      throw new Error(`Model '${model}' is not supported`);
    }
    return model;
  }

  /** Проверяет effort для этого вызова */
  protected resolveEffort(override?: string): string | undefined {
    if (override === undefined) {
      return this.defaultEffort;
    }
    if (!this.effort || this.effort.length === 0) {
      throw new Error("Agent does not support effort");
    }
    if (!effortValuePattern.test(override)) {
      throw new Error(`Effort '${override}' has forbidden characters`);
    }
    if (!this.effort.includes(override)) {
      throw new Error(`Effort '${override}' is not supported`);
    }
    return override;
  }

  /** Собирает сообщения для запроса модели */
  protected buildMessages(
    input: string,
    history: ReadonlyArray<AgentMessage> = [],
  ): ReadonlyArray<AgentMessage> {
    const parsed: Array<AgentMessage> = z
      .array(agentMessageSchema)
      .max(100)
      .parse([...history]);
    return [
      { role: "system", content: this.systemPrompt },
      ...parsed,
      { role: "user", content: input },
    ];
  }

  /** Запускает агента без сохранения состояния */
  abstract run(options?: AgentCallOptions): Promise<string>;

  /** Отправляет текст без сохранения состояния */
  abstract prompt(text: string, options?: AgentCallOptions): Promise<string>;
}
