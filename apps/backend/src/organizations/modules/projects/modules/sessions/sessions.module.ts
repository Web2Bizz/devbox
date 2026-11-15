import { Module, forwardRef } from "@nestjs/common";
import { ProjectAccessModule } from "../project-access/project-access.module";
import { ChatsModule } from "../chats/chats.module";
import { ProjectsModule } from "../../projects.module";
import { SessionsController } from "./sessions.controller";
import { SessionsService } from "./sessions.service";

/**
 * Nested module — imported by ProjectsModule, never registered in AppModule directly.
 * DbService comes from the global CommonModule (503 when PG is down).
 * ProjectAccessModule (sibling) supplies the C4 gate
 * (assertProjectAccess — member-or-owner scoping), so sessions no longer
 * reach up into the organizations module.
 */
@Module({
  imports: [
    ProjectAccessModule,
    forwardRef(() => ProjectsModule),
    forwardRef(() => ChatsModule),
  ],
  controllers: [SessionsController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
