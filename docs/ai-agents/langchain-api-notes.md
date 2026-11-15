# LangChain JS API notes (WEB-7 / A1)

Дата: 2026-11-13. База: `ccbe6ce`. Источник API — только context7 query-docs (ссылки в каждом разделе).
Правило: здесь только точные сигнатуры из документации. Кода раннера нет — он в A2.

## 0. Зафиксированные версии пакетов (репо)

Реестр — `apps/backend/package.json` + `bun.lock` (проверено 2026-11-13):

- `@langchain/core`: `1.3.5` (pin, без `^`)
- `@langchain/openai`: `1.8.2` (pin, без `^`)
- `langchain` (мета-пакет, источник `createAgent`): **не установлен**, в `bun.lock` отсутствует
- `@langchain/langgraph` (источник `MemorySaver`): **не установлен**, в `bun.lock` отсутствует

Вывод для A2: `createAgent` и `MemorySaver` потребуют новых зависимостей
(`langchain`, `@langchain/langgraph`; Postgres-чекпоинтер — отдельный пакет, см. §4).

## 1. `createAgent` — сигнатура и опции

Импорт во всех примерах — из мета-пакета:

```typescript
import { createAgent } from "langchain";
```

Подтверждённые полями вызовы (все поля опциональны, комбинируются):

```typescript
const agent = createAgent({
  model,                    // ChatOpenAI-инстанс ИЛИ строка "openai:gpt-5.5" / "google:gemini-3.6-flash" / "baseten:zai-org/GLM-5.2"
  tools: allTools,          // Array<DynamicStructuredTool>
  systemPrompt: "...",      // string
  stateSchema: SupportState, // кастомная схема состояния
  middleware: [applyStepMiddleware], // Array<middleware>
  checkpointer: new MemorySaver(),   // из "@langchain/langgraph"
});
```

Минимальный вариант с памятью:

```typescript
import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";

const agent = createAgent({
  model: "openai:gpt-5.5",
  tools: [getWeather, searchWeb],
  checkpointer: new MemorySaver(),
});
```

Источники context7 (`/websites/langchain_oss_javascript`):

- https://docs.langchain.com/oss/javascript/langchain/handoffs-customer-support (полный набор опций: `model/tools/stateSchema/middleware/checkpointer`)
- https://docs.langchain.com/oss/javascript/langchain/frontend/overview (минимум с `MemorySaver`)
- https://docs.langchain.com/oss/javascript/langchain/skills-sql-assistant (`systemPrompt + middleware + checkpointer`)
- https://docs.langchain.com/oss/javascript/langchain/middleware/overview (`middleware: [summarizationMiddleware, humanInTheLoopMiddleware]`)
- https://docs.langchain.com/oss/javascript/langchain/short-term-memory (память через `threadConfig`, см. §4)

## 2. Стриминг — `agent.streamEvents` v3 (актуальный API)

```typescript
const stream = await agent.streamEvents(
  { messages: [{ role: "user", content: "What is the weather in SF?" }] },
  { version: "v3" },
);

for await (const message of stream.messages) {
  for await (const delta of message.text) {
    process.stdout.write(delta); // живые текстовые дельты
  }
}

const finalState = await stream.output; // финальное состояние агента
```

С чекпоинтером `thread_id` передаётся в том же втором аргументе:

```typescript
const config = { configurable: { thread_id: uuid7() } };
const stream = await agent.streamEvents(
  { messages: [{ role: "user", content: "what is the weather in sf" }] },
  { ...config, version: "v3" },
);
```

Туki-коллы — две проекции, потребляются конкурентно:

```typescript
const stream = await agent.streamEvents(input, { version: "v3" });
await Promise.all([
  (async () => {
    for await (const message of stream.messages) {
      for await (const chunk of message.toolCalls) {
        console.log("tool call chunk", chunk); // чанки аргументов tool-вызова
      }
    }
  })(),
  (async () => {
    for await (const call of stream.toolCalls) {
      console.log(call.name, call.input);          // старт вызова
      console.log(await call.output, await call.error); // результат/ошибка
    }
  })(),
]);
```

Источники context7 (`/websites/langchain_oss_javascript`):

- https://docs.langchain.com/oss/javascript/langchain/event-streaming (v3, `stream.messages` / `message.text` / `message.toolCalls` / `stream.toolCalls` / `stream.output`)
- https://docs.langchain.com/oss/javascript/langchain/streaming (тот же API + `MemorySaver` + `thread_id`)
- https://docs.langchain.com/oss/javascript/langgraph/event-streaming (сырые каналы: `values/updates/messages/tools/lifecycle/checkpoints/input/tasks/custom`; поле `method` = имя канала)

## 3. `recursionLimit`

Единственная точная форма из полученных документов (deepagents, `stream.submit`):

```typescript
stream.submit(
  { messages: [{ type: "human", content: text }] },
  {
    streamSubgraphs: true,
    config: { recursionLimit: 10000 },
  },
);
```

Источник: https://docs.langchain.com/oss/javascript/deepagents/going-to-production

НЕ подтверждено полученными документами (открыто для A2, не домысливать):

- точное поле `recursionLimit` во втором аргументе `agent.invoke` / `agent.streamEvents`
  для агентов `createAgent` (ожидаемо `config: { recursionLimit }` как часть `RunnableConfig`,
  но цитаты нет — проверить в A2 по `@langchain/langgraph` / `@langchain/core` типам).

## 4. Чекпоинтеры

### 4.1. `MemorySaver` (подтверждено)

```typescript
import { MemorySaver } from "@langchain/langgraph";

const checkpointer = new MemorySaver();
const agent = createAgent({ model: "...", tools: [...], checkpointer });

const threadConfig = { configurable: { thread_id: "1" } };
const result = await agent.invoke(
  { messages: [{ role: "user", content: "Hi! My name is Bob." }] },
  threadConfig, // один и тот же thread_id между вызовами = память
);
```

Источник: https://docs.langchain.com/oss/javascript/langchain/short-term-memory

### 4.2. Postgres-чекпоинтер (НЕ подтверждено — открыто для A2)

В полученных документах `PostgresSaver` / `PostgresStore` не встретился.
Пакет и точный импорт/сигнатура (кандидат — `@langchain/langgraph-checkpoint-postgres`)
должны быть зафиксированы в A2 по context7/docs репозитория, а не по памяти.
Без цитаты в раннер не вносить.

## 5. Middleware (включая счётчик шагов)

Подтверждён только механизм подключения — массив `middleware` в `createAgent`:

```typescript
import { createAgent, summarizationMiddleware, humanInTheLoopMiddleware } from "langchain";

const agent = createAgent({
  model: "gpt-5.5",
  tools: [...],
  middleware: [summarizationMiddleware, humanInTheLoopMiddleware],
});
```

Источник: https://docs.langchain.com/oss/javascript/langchain/middleware/overview

НЕ подтверждено полученными документами (открыто для A2):

- фабрика/сигнатура кастомного middleware для счётчика шагов
  (в документах упоминаются пользовательские `applyStepMiddleware` / `skillMiddleware`
  как элементы того же массива, но их определение в выборку не попало).
  В A2 запросить `query-docs`: "custom middleware wrapModelCall / beforeModel hooks langchain JS".

## 6. Vercel AI SDK `useChat` — только референс формата чанков (НЕ протокол)

`useChat` используется только как образец формы чанков для нашего SSE.
Протокол остаётся доменным (`/api/v1/sessions*`, см. AGENTS.md фронтенда).

Подтверждённая сигнатура (`@ai-sdk/react`, `import { useChat } from '@ai-sdk/react'`):

- Параметры: `chat?` (готовый `Chat`), `transport?` (`DefaultChatTransport`, `api = '/api/chat'`),
  `id?`, `messages?` (`UIMessage[]`), `messageMetadataSchema?`, `dataPartSchemas?`,
  `generateId?`, `onToolCall`, `sendAutomaticallyWhen`, `onFinish`, `onError`, `onData`,
  `throttle?`, `resume?` (`false` по умолчанию).
- Возвращает: `id: string`, `messages: UIMessage[]` (`{ id, role, parts, metadata? }`),
  `status: "ready" | "submitted" | "streaming" | "error"`, `error?: Error`,
  `sendMessage: function`.
- Ввод (`input` + `setInput`) хуком НЕ управляется — это состояние компонента.

Форма чанков (`UIMessageChunk`, точные типы из исходника SDK):

```typescript
export type UIMessageChunk<METADATA = unknown, DATA_TYPES extends UIDataTypes = UIDataTypes> =
  | { type: 'tool-approval-request'; approvalId: string; toolCallId: string; approvalDescriptor?: unknown; inputSchemaInput?: unknown; reason?: string; isAutomatic?: boolean; signature?: string; }
  | DataUIMessageChunk<DATA_TYPES>   // { type: `data-${NAME}`; id?: string; data: ...; transient?: boolean }
  | { type: 'reset-step' }
  | { type: 'abort'; reason?: string }
  | { type: 'message-metadata'; messageMetadata: METADATA }
  // + текстовые/tool/data чанки (полный union — в исходнике по ссылке ниже)
```

Источники context7 (`/vercel/ai`):

- https://github.com/vercel/ai/blob/main/content/docs/07-reference/02-ai-sdk-ui/01-use-chat.mdx (сигнатура `useChat`)
- https://github.com/vercel/ai/blob/main/packages/ai/src/ui-message-stream/ui-message-chunks.ts (типы чанков)

## 7. Открыто для A2 (раннер)

1. Пакет/импорт/сигнатура Postgres-чекпоинтера (§4.2).
2. Точная передача `recursionLimit` в `agent.invoke` / `agent.streamEvents` для `createAgent` (§3).
3. Сигнатура кастомного middleware счётчика шагов (§5).
4. Версии `langchain` и `@langchain/langgraph` для установки (в репо отсутствуют — §0).
