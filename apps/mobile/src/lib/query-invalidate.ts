import { queryClient } from "./query-client"
import { queryKeys, sessionsScopePrefix } from "./query-keys"

// Drop every snapshot scoped to the connection identity (sessions subtree,
// catalog, project info, server projects). Call after any change that swaps
// the client: setActive/add/remove/update connection, directory switch.
// Mounted hooks refetch automatically against the new client.
export function invalidateConnectionScopeQueries() {
  void queryClient.invalidateQueries({ queryKey: sessionsScopePrefix })
  void queryClient.invalidateQueries({ queryKey: queryKeys.catalog })
  void queryClient.invalidateQueries({ queryKey: queryKeys.projectInfo })
  void queryClient.invalidateQueries({ queryKey: queryKeys.serverProjects })
  void queryClient.invalidateQueries({ queryKey: queryKeys.projectRemotes })
}
