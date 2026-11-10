/**
 * backend-util generator — pure-function util at <domainPath>/utils/<name>/.
 * Layout (CoC backend §1, §6): <domainPath>/utils/<name>/index.ts (barrel),
 * <name>.util.ts (pure functions only), __tests__/<name>.spec.ts.
 * Flat *.util.ts files are impossible by construction — paths always nest.
 */
export default function backendUtil(plop) {
  plop.setGenerator("backend-util", {
    description: "Pure-function util <domainPath>/utils/<name>/ (index barrel + <name>.util.ts + __tests__)",
    prompts: [
      {
        type: "input",
        name: "domainPath",
        message: "Domain path in kebab-case (for example auth or organizations/modules/members):",
      },
      {
        type: "input",
        name: "name",
        message: "Util name in kebab-case (for example session-cookie):",
      },
    ],
    actions: [
      {
        type: "add",
        path: "src/{{domainPath}}/utils/{{kebabCase name}}/index.ts",
        template: "export * from './{{kebabCase name}}.util';\n",
      },
      {
        type: "add",
        path: "src/{{domainPath}}/utils/{{kebabCase name}}/{{kebabCase name}}.util.ts",
        template: "/**\n * {{kebabCase name}} pure functions — no side effects, no DI, no logger ownership.\n * Callers pass what the function needs; every const/return carries an explicit type (CoC root §5).\n */\nexport function normalize{{pascalCase name}}Value(value: string): string {\n  const normalized: string = value.trim();\n  return normalized;\n}\n\nexport function build{{pascalCase name}}List(values: Array<string>): Array<string> {\n  const result: Array<string> = values.map((value: string): string => {\n    const normalized: string = normalize{{pascalCase name}}Value(value);\n    return normalized;\n  });\n  return result;\n}\n",
      },
      {
        type: "add",
        path: "src/{{domainPath}}/utils/{{kebabCase name}}/__tests__/{{kebabCase name}}.spec.ts",
        template: "/** {{kebabCase name}} util checks — self-contained runner (plain node:assert, no deps). */\nimport assert from 'node:assert/strict';\nimport { build{{pascalCase name}}List, normalize{{pascalCase name}}Value } from '../{{kebabCase name}}.util';\n\nfunction checks(): void {\n  const normalized: string = normalize{{pascalCase name}}Value('  hello  ');\n  assert.equal(normalized, 'hello');\n  const result: Array<string> = build{{pascalCase name}}List(['  a  ', 'b']);\n  const expected: Array<string> = ['a', 'b'];\n  assert.deepEqual(result, expected);\n}\n\nchecks();\n",
      },
    ],
  });
}
