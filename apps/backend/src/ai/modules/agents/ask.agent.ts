import { Injectable } from '@nestjs/common';

/**
 * Ask agent — answers user questions.
 * Mock implementation: no real AI call yet.
 */
@Injectable()
export class AskAgent {
  readonly id = 'ask';
  readonly name = 'Ask';
  readonly description = 'Answers user questions (mock)';

  async ask(question: string): Promise<string> {
    return `Mock answer to: ${question}`;
  }
}
