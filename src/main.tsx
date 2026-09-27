import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/700.css";
import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { ShareViewer } from "./ShareViewer";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {window.location.pathname.startsWith("/share/") ? <ShareViewer /> : <App />}
  </React.StrictMode>,
);
