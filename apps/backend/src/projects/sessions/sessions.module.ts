import { Module, forwardRef } from "@nestjs/common";
import { DbModule } from "../../db/db.module";
import { OrganizationsModule } from "../../organizations/organizations.module";
import { ChatsModule } from "../chats/chats.module";
import { ProjectsModule } from "../projects.module";
import { SessionsController } from "./sessions.controller";
import { SessionsService } from "./sessions.service";

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
