# Manual migration to the organizations layout

Pre-epic on-disk data is moved **by hand** following this doc — there is
deliberately **no auto-migration code** in the backend (no directory moves
at boot, in services, or in migrations; `drizzle/0004_organizations.sql`
creates fresh tables only and never touches existing rows or the disk).

## Layouts

Old (pre-epic, frozen `<space>/workspace/<repo>`):

```
REPOS_ROOT/<space>/workspace/<repo>        # e.g. REPOS_ROOT/alice/workspace/demo
```

New (organizations epic, uuid-validated, no `workspace` segment —
`WorkspacePathService.resolveUser/resolveOrg` enforce it, 400 on garbage,
403 on traversal):

```
REPOS_ROOT/users/<user-uuid>/projects/<project-uuid>/content    # git repo lives here
REPOS_ROOT/users/<user-uuid>/projects/<project-uuid>/.secrets   # empty reserve, never served
REPOS_ROOT/users/<user-uuid>/.secrets                           # empty scope reserve, never served
REPOS_ROOT/orgs/<org-uuid>/projects/<project-uuid>/content      # org-scoped homes
REPOS_ROOT/orgs/<org-uuid>/projects/<project-uuid>/.secrets     # empty reserve, never served
REPOS_ROOT/orgs/<org-uuid>/.secrets                            # empty scope reserve, never served
```

`sub` paths always anchor under `content` — `../.secrets` escapes 403.

## Mapping old → new

| Old | New | How to resolve the uuid |
| --- | --- | --- |
| `<space>` (user key, e.g. `alice`, `default`) | `users/<user-uuid>` | real user id from the `users` table (`SELECT id FROM users WHERE …`); legacy `default`/mock keys have no row — create the account first (POST /api/v1/auth/register) and use its id |
| `<repo>` (directory name) | `projects/<project-uuid>` | project id from the `projects` table (`SELECT id, owner_id FROM projects WHERE name = …`); the uuid is stable across renames (name is display-only) |
| (org projects, new) | `orgs/<org-uuid>/projects/<project-uuid>` | org id from `organizations` (`SELECT id FROM organizations WHERE name = …`); attach with POST /api/v1/organizations/:id/projects/:projectId (metadata-only join — disk homes are still placed by hand) |

Non-uuid legacy `owner_id` values have no home in the new layout:
reads surface `corrupted: resolve-failed` until the row is hand-migrated
(`ownerId` is immutable via the API — update the row in Postgres
directly, then move the directory).

## Steps (per repo, one at a time)

0. **Stop writes.** Pause callers that create/delete projects or push to
   the repo dir (no lock is taken by the backend — this doc is the lock).
   Snapshot the old dir (`cp -a` or a filesystem snapshot) before moving.
1. **Create the new home** (empty reserves included):
   `mkdir -p REPOS_ROOT/users/<user-uuid>/projects/<project-uuid>/content
   REPOS_ROOT/users/<user-uuid>/projects/<project-uuid>/.secrets
   REPOS_ROOT/users/<user-uuid>/.secrets`
   (org scope: same shape under `orgs/<org-uuid>/…`).
2. **Move the git repo**: `mv REPOS_ROOT/<space>/workspace/<repo>
   REPOS_ROOT/users/<user-uuid>/projects/<project-uuid>/content`
   (contents move INTO `content`, never the scope root; `.secrets` dirs
   stay empty — never copy credentials into them, never commit them).
3. **Verify git**: `git -C <content> rev-parse --git-dir &&
   git -C <content> fsck --no-dangling` (same checks as
   `isValidGitRepo`: missing `.git` → `no-git`, bad ref →
   `rev-parse-failed`, fsck errors → `fsck-failed`).
4. **Verify via the API** (row ↔ disk agreement):
   `GET /api/v1/projects/<project-uuid>` → expect `corrupted: false`;
   `GET /api/v1/repos` lists the repo; `GET
   /api/v1/projects/<project-uuid>/files?path=.&depth=1` → 200.
   Any `corrupted: true` carries a machine `corruptedReason`:
   `missing-dir` (path wrong), `no-git` / `rev-parse-failed` /
   `fsck-failed` (bad move), `resolve-failed` (owner_id not a uuid —
   fix the row, not the disk), `storage-unconfigured` (REPOS_ROOT empty —
   fix env, not data).
5. **Remove the empty old shell** (`rmdir` the now-empty
   `<space>/workspace/<repo>` parents only when empty — never `rm -rf`
   a non-empty dir).

Linking a project to an org does NOT move bytes (POST
/api/v1/organizations/:id/projects/:projectId writes only the
`projects_and_organizations` join row). If the project must physically
live under `orgs/<org-uuid>/…`, `mv` its `content` there by hand with the
same verify steps (the old user home can be removed after).

## Rollback (per repo)

The move is a plain `mv` — rollback is the reverse `mv` while the old
shell still exists:

1. `mv REPOS_ROOT/users/<user-uuid>/projects/<project-uuid>/content
   REPOS_ROOT/<space>/workspace/<repo>` (restore exact old path).
2. `GET /api/v1/projects/<project-uuid>` → expect
   `corrupted: resolve-failed` (old path is outside the new jail — the
   flag proves the row survived; pre-epic code would serve it again).
3. Restore from the step-0 snapshot if the moved tree was modified
   mid-migration (`cp -a` back, re-run the step-3 git checks).

Keep the snapshot until every repo verifies `corrupted: false` in the
new layout; only then delete old shells and snapshots.

## Policy: no auto-move code

The backend MUST NOT move, copy, rename, or delete project directories
outside the explicit per-request flows (`projects.create/remove`,
org disk-init `ensureOrgScope`, best-effort `rm` of the just-created
home). In particular: no boot-time sweeps, no lazy self-healing moves on
`corrupted: true`, no background jobs. A `corrupted` flag is a signal
for the operator to follow this doc — never a trigger for the server to
relocate data. Reviews reject any `rename`/`mv`/`cp` of repo dirs that
is not the operator's shell.
