import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "next-themes";
import App from "./App";
import { HAS_MAC_CHROME } from "./app/TitleBar";
import "./index.css";

// 맥 앱 창: 신호등 버튼 자리와 반투명 창 배경(index.css의 .mac-chrome)
if (HAS_MAC_CHROME) document.documentElement.classList.add("mac-chrome");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" storageKey="classmix-appearance">
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
