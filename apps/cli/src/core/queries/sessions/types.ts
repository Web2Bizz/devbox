// core/queries/sessions/types — session list shapes (local|cloud).
// Pure types only: no I/O, no React, no backend import here.
export type SessionOrigin = "local" | "cloud";

export type SessionInfo = {
  id: string;
  title: string;
  origin: SessionOrigin;
  updatedAt?: string;
};

export type SessionList = SessionInfo[];

export type GridCell = {
  id: string;
  title: string;
  badge: string;
};
