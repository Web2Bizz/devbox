/**
 * backend-domain generator — top-level Nest domain under src/<domain>/.
 * CoC controls baked into every template: export type (&, never interface),
 * Array<T> (never T[]), *At: string ISO-8601 + z.iso.datetime(), full names
 * (error/request/response/configuration/message), explicit name: Type on every
 * const/return, constructors private readonly, logger via ClassName.name.
 */
export default function backendDomain(plop) {
  plop.setGenerator("backend-domain", {
    description: "Top-level backend domain src/<domain>/ (module+controller+service+dto+repository+config+types+spec)",
    prompts: [
      {
        type: "input",
        name: "domain",
        message: "Domain name in kebab-case (for example billing-accounts):",
      },
    ],
    actions: [
      {
        type: "add",
        path: "src/{{kebabCase domain}}/{{kebabCase domain}}.module.ts",
        template: "import { Module } from '@nestjs/common';\nimport { {{pascalCase domain}}Controller } from './{{kebabCase domain}}.controller';\nimport { {{pascalCase domain}}Service } from './{{kebabCase domain}}.service';\nimport { {{pascalCase domain}}Repository } from './{{kebabCase domain}}.repository';\n\n/**\n * {{pascalCase domain}}Module — single Nest module for the {{kebabCase domain}} domain (CoC backend §1).\n * Registered in AppModule imports; nested modules live in modules/ and are imported here.\n */\n@Module({\n  controllers: [{{pascalCase domain}}Controller],\n  providers: [{{pascalCase domain}}Service, {{pascalCase domain}}Repository],\n  exports: [{{pascalCase domain}}Service],\n})\nexport class {{pascalCase domain}}Module {}\n",
      },
      {
        type: "add",
        path: "src/{{kebabCase domain}}/{{kebabCase domain}}.controller.ts",
        template: "import { Controller, Get, UseGuards } from '@nestjs/common';\nimport { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';\nimport { AppLogger } from '@common/logger';\nimport { JwtAuthGuard } from '../auth/jwt-auth.guard';\nimport { {{pascalCase domain}}Service } from './{{kebabCase domain}}.service';\nimport { {{pascalCase domain}}Dto } from './{{kebabCase domain}}.dto';\n\n/**\n * {{pascalCase domain}}Controller — thin HTTP layer for its own entity only (CoC backend §1.1).\n * Guard first, then service; no business logic here.\n */\n@ApiTags('{{kebabCase domain}}')\n@Controller('{{kebabCase domain}}')\nexport class {{pascalCase domain}}Controller {\n  private readonly logger: AppLogger = new AppLogger({{pascalCase domain}}Controller.name);\n  constructor(private readonly domainService: {{pascalCase domain}}Service) {}\n\n  @Get()\n  @UseGuards(JwtAuthGuard)\n  @ApiBearerAuth()\n  @ApiOperation({ summary: 'List {{kebabCase domain}} entries' })\n  @ApiResponse({ status: 200, type: {{pascalCase domain}}Dto, isArray: true })\n  async listEntries(): Promise<Array<{{pascalCase domain}}Dto>> {\n    const entries: Array<{{pascalCase domain}}Dto> = await this.domainService.listEntries();\n    this.logger.info('[{{kebabCase domain}}] list ok');\n    return entries;\n  }\n}\n",
      },
      {
        type: "add",
        path: "src/{{kebabCase domain}}/{{kebabCase domain}}.service.ts",
        template: "import { Injectable } from '@nestjs/common';\nimport { AppLogger } from '@common/logger';\nimport { {{pascalCase domain}}Repository } from './{{kebabCase domain}}.repository';\nimport type { {{pascalCase domain}}Item } from './{{kebabCase domain}}.types';\n\n/**\n * {{pascalCase domain}}Service — business logic, the only place for side effects.\n * Never imports drizzle-orm or the schema; all queries live in the repository.\n */\n@Injectable()\nexport class {{pascalCase domain}}Service {\n  private readonly logger: AppLogger = new AppLogger({{pascalCase domain}}Service.name);\n  constructor(private readonly domainRepository: {{pascalCase domain}}Repository) {}\n\n  async listEntries(correlationId?: string): Promise<Array<{{pascalCase domain}}Item>> {\n    const items: Array<{{pascalCase domain}}Item> = await this.domainRepository.findAll(correlationId);\n    this.logger.info('[{{kebabCase domain}}] list ok');\n    return items;\n  }\n}\n",
      },
      {
        type: "add",
        path: "src/{{kebabCase domain}}/{{kebabCase domain}}.dto.ts",
        template: "import { ApiProperty } from '@nestjs/swagger';\nimport { z } from 'zod';\n\n/**\n * {{pascalCase domain}} DTO — runtime comes from @rush-code/contracts (single source),\n * swagger classes here are docs only (CoC backend §4). Runtime validation is zod\n * through ZodValidationPipe, never the swagger classes.\n */\nexport * from '@rush-code/contracts';\n\n/** Boundary schema — every *At field is strict ISO-8601 (CoC root §2). */\nexport const {{camelCase domain}}Schema: z.ZodObject<{\n  id: z.ZodString;\n  createdAt: z.ZodISODateTime;\n}> = z.object({\n  id: z.string().min(1),\n  createdAt: z.iso.datetime(),\n});\n\nexport type {{pascalCase domain}}SchemaInput = z.infer<typeof {{camelCase domain}}Schema>;\n\n/** Swagger shape — docs only, never used for validation. */\nexport class {{pascalCase domain}}Dto {\n  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })\n  id!: string;\n\n  /** ISO-8601 timestamp */\n  @ApiProperty({ example: '2026-10-01T00:00:00.000Z' })\n  createdAt!: string;\n}\n",
      },
      {
        type: "add",
        path: "src/{{kebabCase domain}}/{{kebabCase domain}}.repository.ts",
        template: "import { Injectable } from '@nestjs/common';\nimport { DbService, type DbClient } from '@common/db/db.service';\nimport type { {{pascalCase domain}}Item } from './{{kebabCase domain}}.types';\n\n/**\n * {{pascalCase domain}}Repository — the only place in this domain that touches drizzle.\n * DB timestamps convert to ISO-8601 via toISOString() at the boundary (CoC root §2).\n */\n@Injectable()\nexport class {{pascalCase domain}}Repository {\n  constructor(private readonly databaseService: DbService) {}\n\n  private client(): DbClient {\n    const client: DbClient = this.databaseService.client;\n    return client;\n  }\n\n  async findAll(correlationId?: string): Promise<Array<{{pascalCase domain}}Item>> {\n    void correlationId;\n    const client: DbClient = this.client();\n    void client;\n    const items: Array<{{pascalCase domain}}Item> = [];\n    return items;\n  }\n}\n",
      },
      {
        type: "add",
        path: "src/{{kebabCase domain}}/{{kebabCase domain}}.config.ts",
        template: "/** {{pascalCase domain}} domain configuration (validated env slice, no literals at call sites). */\nexport type {{pascalCase domain}}Configuration = {\n  enabled: boolean;\n  pageSize: number;\n};\n\nexport function default{{pascalCase domain}}Configuration(): {{pascalCase domain}}Configuration {\n  const configuration: {{pascalCase domain}}Configuration = { enabled: true, pageSize: 50 };\n  return configuration;\n}\n",
      },
      {
        type: "add",
        path: "src/{{kebabCase domain}}/{{kebabCase domain}}.types.ts",
        template: "/**\n * {{pascalCase domain}} domain types — export type only (& intersection, never interface, CoC root §1).\n * Every *At field is an ISO-8601 string (CoC root §2); arrays are Array<T> (CoC root §3).\n */\nexport type {{pascalCase domain}}Item = {\n  id: string;\n  /** ISO-8601 timestamp */\n  createdAt: string;\n  /** ISO-8601 timestamp */\n  updatedAt: string;\n};\n\nexport type {{pascalCase domain}}List = Array<{{pascalCase domain}}Item>;\n",
      },
      {
        type: "add",
        path: "src/{{kebabCase domain}}/__tests__/{{kebabCase domain}}.spec.ts",
        template: "/**\n * {{pascalCase domain}} unit checks — self-contained runner (plain node:assert, no deps).\n * Runs against COMPILED dist: `bun run build && bun dist/{{kebabCase domain}}/__tests__/{{kebabCase domain}}.spec.js`.\n */\nimport assert from 'node:assert/strict';\nimport { {{pascalCase domain}}Service } from '../{{kebabCase domain}}.service';\nimport type { {{pascalCase domain}}Item } from '../{{kebabCase domain}}.types';\n\nfunction makeService(repository: { findAll: (correlationId?: string) => Promise<Array<{{pascalCase domain}}Item>> }): {{pascalCase domain}}Service {\n  const service: {{pascalCase domain}}Service = new {{pascalCase domain}}Service(repository as never);\n  return service;\n}\n\nasync function checks(): Promise<void> {\n  const fixture: {{pascalCase domain}}Item = {\n    id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',\n    createdAt: '2026-10-01T00:00:00.000Z',\n    updatedAt: '2026-10-02T00:00:00.000Z',\n  };\n  const items: Array<{{pascalCase domain}}Item> = [fixture];\n  const service: {{pascalCase domain}}Service = makeService({\n    findAll: async (correlationId?: string): Promise<Array<{{pascalCase domain}}Item>> => {\n      void correlationId;\n      return items;\n    },\n  });\n  const result: Array<{{pascalCase domain}}Item> = await service.listEntries();\n  assert.deepEqual(result, items);\n}\n\nchecks().then(\n  (): void => {\n    return undefined;\n  },\n  (error: unknown): void => {\n    throw error;\n  },\n);\n",
      },
    ],
  });
}
