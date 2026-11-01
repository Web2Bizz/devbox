import { Module, forwardRef } from "@nestjs/common";
import { OrganizationsModule } from "../../../../../organizations/organizations.module";
import { ProjectsModule } from "../../projects.module";
import { SessionsModule } from "../sessions/sessions.module";
import { ChatsController } from "./chats.controller";
import { ChatsService } from "./chats.service";

/**
 * Nested module — imported by ProjectsModule, never registered in AppModule directly.
 * DbService comes from the global CommonModule (503 when PG is down).
 * SessionsModule (forwardRef) supplies SessionsService for chat-delete
 * detach (sessions survive with chat_id → NULL).
 * OrganizationsModule supplies the Card 5 access gate (member-or-owner
 * scoping, no cycle: orgs import nothing from ai/projects).
 */
@Module({
  imports: [
    forwardRef(() => OrganizationsModule),
    forwardRef(() => ProjectsModule),
    forwardRef(() => SessionsModule),
  ],
  controllers: [ChatsController],
  providers: [ChatsService],
  exports: [ChatsService],
})
export class ChatsModule {}
