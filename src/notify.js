import { execFile } from "node:child_process";

const enabled = process.platform === "darwin" && (process.env.NOTIFY || "true").toLowerCase() !== "false";

export function notify(title, body = "") {
  if (!enabled) return;
  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  execFile("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`], () => {});
}
