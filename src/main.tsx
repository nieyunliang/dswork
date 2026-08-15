import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "./hooks/useTheme";
import AntdProvider from "./AntdProvider";
import { DeepSeekConfigProvider } from "./hooks/useDeepSeekConfig";
import { SessionsProvider } from "./hooks/useSessions";
import { SkillsProvider } from "./hooks/useSkills";
import { TasksProvider } from "./hooks/useTasks";
import App from "./App";
import "./components/bui/tokens.css";
import "./App.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <AntdProvider>
        <DeepSeekConfigProvider>
          <SessionsProvider>
            <SkillsProvider>
              <TasksProvider>
                <App />
              </TasksProvider>
            </SkillsProvider>
          </SessionsProvider>
        </DeepSeekConfigProvider>
      </AntdProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
