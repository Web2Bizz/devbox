import { Module, forwardRef } from "@nestjs/common";
import { OrganizationsModule } from "../../../../../organizations/organizations.module";
import { ChatsModule } from "../chats/chats.module";
import { ProjectsModule } from "../../projects.module";
import { SessionsController } from "./sessions.controller";
import { SessionsService } from "./sessions.service";

/**
 * Nested module — imported by ProjectsModule, never registered in AppModule directly.
 * DbService comes from the global CommonModule (503 when PG is down).
 * OrganizationsModule supplies the Card 5 access gate
 * (assertProjectAccess — member-or-owner scoping, no cycle).
 */
@Module({
  imports: [
    forwardRef(() => OrganizationsModule),
    forwardRef(() => ProjectsModule),
    forwardRef(() => ChatsModule),
  ],
  controllers: [SessionsController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
