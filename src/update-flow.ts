import "./update-overlay.css";
import { openUpdateOverlay } from "./update-overlay.js";

export function openVoltUpdates(component: "volt" = "volt") {
  return openUpdateOverlay({ service: "volt", component, base: "/api/v1/update-flow" });
}
