import { Module, forwardRef } from "@nestjs/common";
import { ProjectsModule } from "../../projects.module";
import { ProjectAccessModule } from "../project-access/project-access.module";
import { SessionsModule } from "../sessions/sessions.module";
import { ChatsController } from "./chats.controller";
import { ChatsService } from "./chats.service";

/**
 * Nested module — imported by ProjectsModule, never registered in AppModule directly.
 * DbService comes from the global CommonModule (503 when PG is down).
 * SessionsModule (forwardRef) supplies SessionsService for chat-delete
 * detach (sessions survive with chat_id → NULL).
 * ProjectAccessModule supplies the C4 gate (member-or-owner scoping) —
 * a sibling of this module, so chats no longer reach up into the
 * organizations module.
 */
@Module({
  imports: [
    ProjectAccessModule,
    forwardRef(() => ProjectsModule),
    forwardRef(() => SessionsModule),
  ],
  controllers: [ChatsController],
  providers: [ChatsService],
  exports: [ChatsService],
})
export class ChatsModule {}
