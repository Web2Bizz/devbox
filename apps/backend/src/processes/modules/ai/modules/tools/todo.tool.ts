import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolHandler } from '../tool-runtime/tool-runtime.types';

const statusSchema: z.ZodEnum<{
  pending: 'pending';
  in_progress: 'in_progress';
  completed: 'completed';
  cancelled: 'cancelled';
}> = z.enum(['pending', 'in_progress', 'completed', 'cancelled']);

const inputSchema: z.ZodObject<{
  todos: z.ZodArray<
    z.ZodObject<{ id: z.ZodString; content: z.ZodString; status: typeof statusSchema }>
  >;
}> = z.object({
  todos: z.array(
    z.object({
      id: z.string().min(1),
      content: z.string({ error: 'field "content" is required' }).min(1),
      status: statusSchema,
    }),
  ),
});

export type TodoItem = z.infer<typeof inputSchema>['todos'][number];

/**
 * todo — per-session task list (the model replaces it wholesale; nothing is
 * durable server-side yet, the last call wins). Session id scopes entries so
 * two chat sessions never share a plan.
 */
@Injectable()
export class TodoTool implements ToolHandler {
  readonly fullName: string = 'todo';
  readonly definition: ToolDefinition = {
    name: 'todo',
    description: 'Replace the session todo list (id/content/status per item).',
    inputSchema: {
      type: 'object',
      required: ['todos'],
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'content', 'status'],
            properties: {
              id: { type: 'string' },
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
            },
          },
        },
      },
    },
  };

  private readonly lists: Map<string, Array<TodoItem>> = new Map<string, Array<TodoItem>>();

  async execute(input: unknown, context: ToolContext): Promise<string> {
    const parsed: z.ZodSafeParseResult<{ todos: Array<TodoItem> }> = inputSchema.safeParse(input);
    if (!parsed.success) return 'error: invalid input, expected { todos: Array<{id, content, status}> }';
    const key: string = context.sessionId ?? context.directory;
    this.lists.set(key, parsed.data.todos);
    if (parsed.data.todos.length === 0) return 'todo list cleared';
    return parsed.data.todos.map((item) => `[${item.status}] ${item.id}: ${item.content}`).join('\n');
  }
}
