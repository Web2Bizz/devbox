import { Module, forwardRef } from "@nestjs/common";
import { DbModule } from "../../db/db.module.js";
import { OrganizationsModule } from "../../organizations/organizations.module.js";
import { ChatsModule } from "../chats/chats.module.js";
import { ProjectsModule } from "../projects.module.js";
import { SessionsController } from "./sessions.controller.js";
import { SessionsService } from "./sessions.service.js";

/**
 * Nested module — imported by ProjectsModule, never registered in AppModule directly.
 * DbModule wires the strict-Postgres SessionsService (503 when PG is down).
 * OrganizationsModule supplies the Card 5 access gate
 * (assertProjectAccess — member-or-owner scoping, no cycle: orgs import
 * only DbModule).
 */
@Module({
  imports: [
    DbModule,
    OrganizationsModule,
    forwardRef(() => ProjectsModule),
    forwardRef(() => ChatsModule),
  ],
  controllers: [SessionsController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
