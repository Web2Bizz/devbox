import { Module, forwardRef } from "@nestjs/common";
import { DbModule } from "../../db/db.module";
import { OrganizationsModule } from "../../organizations/organizations.module";
import { ProjectsModule } from "../projects.module";
import { SessionsModule } from "../sessions/sessions.module";
import { ChatsController } from "./chats.controller";
import { ChatsService } from "./chats.service";

/**
 * Nested module — imported by ProjectsModule, never registered in AppModule directly.
 * DbModule wires the strict-Postgres ChatsService (503 when PG is down).
 * SessionsModule (forwardRef) supplies SessionsService for chat-delete
 * detach (sessions survive with chat_id → NULL).
 * OrganizationsModule supplies the Card 5 access gate (member-or-owner
 * scoping, no cycle: orgs import only DbModule).
 */
@Module({
  imports: [
    DbModule,
    OrganizationsModule,
    forwardRef(() => ProjectsModule),
    forwardRef(() => SessionsModule),
  ],
  controllers: [ChatsController],
  providers: [ChatsService],
  exports: [ChatsService],
})
export class ChatsModule {}
