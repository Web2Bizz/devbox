/**
 * session-commands util checks — self-contained runner (plain node:assert).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/processes/modules/ai/modules/sessions/utils/session-commands/__tests__/session-commands.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers the jailed file/shell command bridge parsing (RU+EN), token cleanup
 * (wrapping quotes / trailing punctuation), null-byte rejection, non-command
 * text, and the shape-agnostic shell output projection.
 */
import assert from 'node:assert/strict';
import {
  cleanFileToken,
  formatShellOutput,
  parseCreateFileCommand,
  parseReadFileCommand,
  parseShellCommand,
} from '..';

const checks: Array<{ name: string; run: () => void }> = [
  {
    name: 'cleanFileToken strips wrapping quotes and trailing punctuation',
    run: () => {
      assert.equal(cleanFileToken(' "app.ts" '), 'app.ts');
      assert.equal(cleanFileToken('`src/index.ts`'), 'src/index.ts');
      assert.equal(cleanFileToken('«README.md»'), 'README.md');
      assert.equal(cleanFileToken('README.md.'), 'README.md');
      assert.equal(cleanFileToken('file.ts!'), 'file.ts');
      assert.equal(cleanFileToken('  notes.txt  '), 'notes.txt');
    },
  },
  {
    name: 'create file command (RU) — name only / with text / with content',
    run: () => {
      assert.deepEqual(parseCreateFileCommand('создай файл notes.txt'), {
        filename: 'notes.txt',
        content: '',
      });
      assert.deepEqual(parseCreateFileCommand('создать файл «отчёт.md» с текстом: привет'), {
        filename: 'отчёт.md',
        content: 'привет',
      });
      assert.deepEqual(parseCreateFileCommand('создай файл app.ts с содержимым "console.log(1)"'), {
        filename: 'app.ts',
        content: 'console.log(1)',
      });
    },
  },
  {
    name: 'create file command (EN) — name only / with text',
    run: () => {
      assert.deepEqual(parseCreateFileCommand('create file src/main.ts'), {
        filename: 'src/main.ts',
        content: '',
      });
      assert.deepEqual(parseCreateFileCommand('create file "index.html" with text <h1>hi</h1>'), {
        filename: 'index.html',
        content: '<h1>hi</h1>',
      });
    },
  },
  {
    name: 'create file command rejects null bytes, empty names and non-commands',
    run: () => {
      assert.equal(parseCreateFileCommand('create file bad\0name.ts'), null);
      assert.equal(parseCreateFileCommand('создай файл bad\0name.ts'), null);
      assert.equal(parseCreateFileCommand('create file '), null);
      assert.equal(parseCreateFileCommand('создай файл'), null);
      assert.equal(parseCreateFileCommand('hello world'), null);
    },
  },
  {
    name: 'read file command (RU+EN) — quotes and punctuation cleaned',
    run: () => {
      assert.deepEqual(parseReadFileCommand('прочитай файл README.md'), { filename: 'README.md' });
      assert.deepEqual(parseReadFileCommand('покажи файл "package.json"'), {
        filename: 'package.json',
      });
      assert.deepEqual(parseReadFileCommand('показать файл «src/index.ts»'), {
        filename: 'src/index.ts',
      });
      assert.deepEqual(parseReadFileCommand('read file src/index.ts'), { filename: 'src/index.ts' });
      assert.deepEqual(parseReadFileCommand('show file README.md.'), { filename: 'README.md' });
    },
  },
  {
    name: 'read file command rejects null bytes and non-commands',
    run: () => {
      assert.equal(parseReadFileCommand('read file a\0b'), null);
      assert.equal(parseReadFileCommand('read the file README.md'), null);
      assert.equal(parseReadFileCommand('show me README.md'), null);
    },
  },
  {
    name: 'shell command (RU+EN) — colon and plain forms',
    run: () => {
      assert.equal(parseShellCommand('выполни ls -la'), 'ls -la');
      assert.equal(parseShellCommand('запусти: echo привет'), 'echo привет');
      assert.equal(parseShellCommand('run bun test'), 'bun test');
      assert.equal(parseShellCommand('shell: pwd'), 'pwd');
      assert.equal(parseShellCommand('  run   ls  '), 'ls');
    },
  },
  {
    name: 'shell command rejects empty command and non-commands',
    run: () => {
      assert.equal(parseShellCommand('run'), null);
      assert.equal(parseShellCommand('run   '), null);
      assert.equal(parseShellCommand('выполни:'), null);
      assert.equal(parseShellCommand('ls -la'), null);
      assert.equal(parseShellCommand(''), null);
    },
  },
  {
    name: 'formatShellOutput — plain string passthrough',
    run: () => {
      assert.equal(formatShellOutput('done'), 'done');
      assert.equal(formatShellOutput(''), '');
    },
  },
  {
    name: 'formatShellOutput — named payload keys (output/stdout/text/content/result)',
    run: () => {
      assert.equal(formatShellOutput({ output: 'out' }), 'out');
      assert.equal(formatShellOutput({ stdout: 'stdout' }), 'stdout');
      assert.equal(formatShellOutput({ text: 'text' }), 'text');
      assert.equal(formatShellOutput({ content: 'content' }), 'content');
      assert.equal(formatShellOutput({ result: 'result' }), 'result');
      assert.equal(formatShellOutput({ stdout: '', output: 'fallback' }), 'fallback');
    },
  },
  {
    name: 'formatShellOutput — object without known keys → JSON; null/non-object → empty',
    run: () => {
      assert.equal(formatShellOutput({ foo: 1 }), '{"foo":1}');
      assert.equal(formatShellOutput({}), '{}');
      assert.equal(formatShellOutput(null), '');
      assert.equal(formatShellOutput(undefined), '');
      assert.equal(formatShellOutput(42), '');
    },
  },
];

function main(): void {
  let failed = 0;
  for (const c of checks) {
    try {
      c.run();
      console.log(`ok - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  if (failed > 0) {
    console.error(`${failed}/${checks.length} session-commands checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} session-commands checks failed`);
  }
  console.log(`${checks.length}/${checks.length} session-commands checks passed`);
}

main();
