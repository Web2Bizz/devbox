export type SidebarNavItem = { href: string; label: string };

export type SessionsSidebarProps = {
  orgId: string;
  projectId: string;
  /** Project nav items — rendered on every non-session route. */
  items?: ReadonlyArray<SidebarNavItem>;
};

export type SessionListProps = {
  orgId: string;
  projectId: string;
  currentSessionId?: string;
};
