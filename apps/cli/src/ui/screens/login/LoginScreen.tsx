// ui/screens/login/LoginScreen — plain login hint + health status.
// Presentational: no fs, no stdio, no secrets. fg-only, width 100%, no border.
import { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { checkBackendHealth } from "../../../core/backend.js";

export type LoginScreenProps = {
  loginUrl?: string;
  onDone: () => void;
  onCancel: () => void;
};

export function LoginScreen({ loginUrl, onDone, onCancel }: LoginScreenProps) {
  const [backendStatus, setBackendStatus] = useState<"connecting" | "online" | "offline">("connecting");
  useEffect(() => {
    let active = true;
    void (async () => {
      const online = await checkBackendHealth();
      if (active) setBackendStatus(online ? "online" : "offline");
    })();
    return () => {
      active = false;
    };
  }, []);
  useKeyboard((key) => {
    if (key.name === "return" || key.name === "linefeed" || key.name === "enter") {
      onDone();
      return;
    }
    if (key.name === "escape" || key.name === "q") onCancel();
  });
  return (
    <box flexDirection="column" justifyContent="center" alignItems="stretch" width="100%" height="100%">
      <text width="100%">{"вход — открой страницу входа"}</text>
      <text width="100%">{" "}</text>
      <text width="100%">{loginUrl ?? "RUSH_CODE_BACKEND_URL/api/v1/login"}</text>
      <text width="100%">{" "}</text>
      <text fg={backendStatus === "online" ? "green" : backendStatus === "offline" ? "red" : "yellow"} width="100%">
        {backendStatus === "online" ? " online" : backendStatus === "offline" ? " offline" : " connecting"}
      </text>
      <text width="100%">{" "}</text>
      <text width="100%">{"Enter — готово · Esc — назад"}</text>
    </box>
  );
}
