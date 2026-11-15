/**
 * backend-sub generator — nested Nest module under src/<parent>/modules/<sub>/.
 * Mirrors the domain layout (CoC backend §2): own module/controller/service/dto
 * plus __tests__ inside. The sub-controller owns the sub-entity routes (CoC §1.1).
 */
export default function backendSub(plop) {
  plop.setGenerator("backend-sub", {
    description: "Nested backend module src/<parent>/modules/<sub>/ with its own controller and __tests__",
    prompts: [
      {
        type: "input",
        name: "parent",
        message: "Parent domain in kebab-case (for example organizations):",
      },
      {
        type: "input",
        name: "sub",
        message: "Sub-module name in kebab-case (for example members):",
      },
    ],
    actions: [
      {
        type: "add",
        path: "src/{{kebabCase parent}}/modules/{{kebabCase sub}}/{{kebabCase sub}}.module.ts",
        template: "import { Module } from '@nestjs/common';\nimport { {{pascalCase sub}}Controller } from './{{kebabCase sub}}.controller';\nimport { {{pascalCase sub}}Service } from './{{kebabCase sub}}.service';\n\n/**\n * {{pascalCase sub}}Module — nested module of {{kebabCase parent}} (CoC backend §2).\n * Imported only by the parent module, never registered in AppModule directly.\n */\n@Module({\n  controllers: [{{pascalCase sub}}Controller],\n  providers: [{{pascalCase sub}}Service],\n  exports: [{{pascalCase sub}}Service],\n})\nexport class {{pascalCase sub}}Module {}\n",
      },
      {
        type: "add",
        path: "src/{{kebabCase parent}}/modules/{{kebabCase sub}}/{{kebabCase sub}}.controller.ts",
        template: "import { Controller, Get, UseGuards } from '@nestjs/common';\nimport { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';\nimport { AppLogger } from '@common/logger';\nimport { JwtAuthGuard } from '../../../auth/jwt-auth.guard';\nimport { {{pascalCase sub}}Service } from './{{kebabCase sub}}.service';\nimport { {{pascalCase sub}}Dto } from './{{kebabCase sub}}.dto';\n\n/**\n * {{pascalCase sub}}Controller — owns only the {{kebabCase sub}} routes (CoC backend §1.1).\n * The parent controller never serves nested-entity routes.\n */\n@ApiTags('{{kebabCase parent}}-{{kebabCase sub}}')\n@Controller('{{kebabCase parent}}')\nexport class {{pascalCase sub}}Controller {\n  private readonly logger: AppLogger = new AppLogger({{pascalCase sub}}Controller.name);\n  constructor(private readonly subService: {{pascalCase sub}}Service) {}\n\n  @Get()\n  @UseGuards(JwtAuthGuard)\n  @ApiBearerAuth()\n  @ApiOperation({ summary: 'List {{kebabCase sub}} entries' })\n  @ApiResponse({ status: 200, type: {{pascalCase sub}}Dto, isArray: true })\n  async listEntries(): Promise<Array<{{pascalCase sub}}Dto>> {\n    const entries: Array<{{pascalCase sub}}Dto> = await this.subService.listEntries();\n    this.logger.info('[{{kebabCase sub}}] list ok');\n    return entries;\n  }\n}\n",
      },
      {
        type: "add",
        path: "src/{{kebabCase parent}}/modules/{{kebabCase sub}}/{{kebabCase sub}}.service.ts",
        template: "import { Injectable } from '@nestjs/common';\nimport { AppLogger } from '@common/logger';\nimport type { {{pascalCase sub}}Item } from './{{kebabCase sub}}.types';\n\n/** {{pascalCase sub}}Service — business logic of the nested module (side effects only here). */\n@Injectable()\nexport class {{pascalCase sub}}Service {\n  private readonly logger: AppLogger = new AppLogger({{pascalCase sub}}Service.name);\n  constructor() {}\n\n  async listEntries(correlationId?: string): Promise<Array<{{pascalCase sub}}Item>> {\n    void correlationId;\n    const items: Array<{{pascalCase sub}}Item> = [];\n    this.logger.info('[{{kebabCase sub}}] list ok');\n    return items;\n  }\n}\n",
      },
      {
        type: "add",
        path: "src/{{kebabCase parent}}/modules/{{kebabCase sub}}/{{kebabCase sub}}.dto.ts",
        template: "import { ApiProperty } from '@nestjs/swagger';\nimport { z } from 'zod';\n\n/** {{pascalCase sub}} DTO — runtime from @rush-code/contracts; swagger classes are docs only (CoC backend §4). */\nexport * from '@rush-code/contracts';\n\n/** Boundary schema — every *At field is strict ISO-8601 (CoC root §2). */\nexport const {{camelCase sub}}Schema: z.ZodObject<{\n  id: z.ZodString;\n  createdAt: z.ZodISODateTime;\n}> = z.object({\n  id: z.string().min(1),\n  createdAt: z.iso.datetime(),\n});\n\nexport type {{pascalCase sub}}SchemaInput = z.infer<typeof {{camelCase sub}}Schema>;\n\n/** Swagger shape — docs only, never used for validation (ZodValidationPipe owns runtime). */\nexport class {{pascalCase sub}}Dto {\n  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })\n  id!: string;\n\n  /** ISO-8601 timestamp */\n  @ApiProperty({ example: '2026-10-01T00:00:00.000Z' })\n  createdAt!: string;\n}\n",
      },
      {
        type: "add",
        path: "src/{{kebabCase parent}}/modules/{{kebabCase sub}}/{{kebabCase sub}}.types.ts",
        template: "/** {{pascalCase sub}} nested-module types — export type only (&, never interface, CoC root §1). */\nexport type {{pascalCase sub}}Item = {\n  id: string;\n  /** ISO-8601 timestamp */\n  createdAt: string;\n  /** ISO-8601 timestamp */\n  updatedAt: string;\n};\n\nexport type {{pascalCase sub}}List = Array<{{pascalCase sub}}Item>;\n",
      },
      {
        type: "add",
        path: "src/{{kebabCase parent}}/modules/{{kebabCase sub}}/__tests__/{{kebabCase sub}}.spec.ts",
        template: "/** {{pascalCase sub}} unit checks — self-contained runner (plain node:assert, no deps). */\nimport assert from 'node:assert/strict';\nimport { {{pascalCase sub}}Service } from '../{{kebabCase sub}}.service';\nimport type { {{pascalCase sub}}Item } from '../{{kebabCase sub}}.types';\n\nasync function checks(): Promise<void> {\n  const service: {{pascalCase sub}}Service = new {{pascalCase sub}}Service();\n  const result: Array<{{pascalCase sub}}Item> = await service.listEntries();\n  const expected: Array<{{pascalCase sub}}Item> = [];\n  assert.deepEqual(result, expected);\n}\n\nchecks().then(\n  (): void => {\n    return undefined;\n  },\n  (error: unknown): void => {\n    throw error;\n  },\n);\n",
      },
    ],
  });
}
