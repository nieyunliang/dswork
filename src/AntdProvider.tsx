import type { ReactNode } from "react";
import { App as AntdApp, ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { useTheme } from "./hooks/useTheme";

/* antd theme wired to the design tokens from components/bui/tokens.css
   (:root light palette / .dark overrides) and the useTheme hook. */

const FONT =
  '"Inter", ui-sans-serif, system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';

const THEME = {
  light: {
    colorPrimary: "#0285ff", // --accent
    colorInfo: "#0285ff",
    colorSuccess: "#189a4d", // --green
    colorWarning: "#ef720c", // --orange
    colorError: "#e3474c", // --red
    colorText: "#1f2124", // --ink
    colorTextSecondary: "#62656b", // --ink-2
    colorTextTertiary: "#9a9da3", // --ink-3
    colorBorder: "#e0e2e5", // --line-strong
    colorBorderSecondary: "#ecedef", // --line
    colorSplit: "#ecedef",
    colorBgContainer: "#ffffff", // --surface
    colorBgElevated: "#ffffff",
    colorBgLayout: "#fafafb", // --page
    colorBgSpotlight: "#25272b", // --tooltip-bg
    colorFillTertiary: "#f2f2f3", // --field (filled inputs)
  },
  dark: {
    colorPrimary: "#3d9aff",
    colorInfo: "#3d9aff",
    colorSuccess: "#3dbb72",
    colorWarning: "#f68f3c",
    colorError: "#ee5c61",
    colorText: "#f2f3f4",
    colorTextSecondary: "#a5a8ad",
    colorTextTertiary: "#6c6f75",
    colorBorder: "#3a3c40",
    colorBorderSecondary: "#2e3033",
    colorSplit: "#2e3033",
    colorBgContainer: "#232427",
    colorBgElevated: "#232427",
    colorBgLayout: "#17181a",
    colorBgSpotlight: "#111214",
    colorFillTertiary: "#2b2c2f",
  },
};

export default function AntdProvider({ children }: { children: ReactNode }) {
  const { isDark } = useTheme();
  const tokens = THEME[isDark ? "dark" : "light"];
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          ...tokens,
          fontFamily: FONT,
          fontSize: 13,
          borderRadius: 8, // --radius-control
          borderRadiusLG: 10, // --radius-card
          borderRadiusSM: 6, // --radius-chip
          controlHeightSM: 28,
        },
        components: {
          Button: {
            primaryShadow: "none",
            defaultShadow: "none",
            dangerShadow: "none",
          },
          Modal: { titleFontSize: 14 },
          Spin: { dotSizeSM: 14 },
        },
      }}
    >
      <AntdApp>{children}</AntdApp>
    </ConfigProvider>
  );
}
