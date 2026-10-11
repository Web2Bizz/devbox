import { Redirect } from "expo-router"

export default function NewProjectPlaceholder() {
  // This route is never actually navigated to — Tabs.Screen new-project
  // intercepts tabPress and opens the new-project modal via useUi store.
  // If somehow navigated here (deep link), redirect to projects.
  return <Redirect href="/(tabs)" />
}
