import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Dropdown, Tooltip } from "antd";
import type { MenuProps } from "antd";
import deepseekLogo from "../../assets/deepseek-logo.svg";

export interface MenuItem {
  key?: string;
  label?: React.ReactNode;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  type?: "divider";
  onClick?: () => void;
}

/* Convert the custom per-item onClick closures into antd's menu config,
   which dispatches all clicks through menu.onClick({ key }). */
function toMenuProps(items: MenuItem[]): MenuProps {
  const handlers = new Map<string, () => void>();
  const menuItems: MenuProps["items"] = items.map((item, i) => {
    const key = item.key ?? `item-${i}`;
    if (item.onClick) handlers.set(key, item.onClick);
    if (item.type === "divider") {
      return { key, type: "divider" };
    }
    return {
      key,
      label: item.label,
      icon: item.icon,
      danger: item.danger,
      disabled: item.disabled,
    };
  });
  return { items: menuItems, onClick: ({ key }) => handlers.get(key as string)?.() };
}

/* ─────────────────────────────────────────────────────────
 * SIDEBAR NAV
 * Workspace navigation with direct selection and search.
 *
 * Demo mode (demo, default) renders the ice-cream demo nav.
 * App mode (demo=false) drives everything from props:
 * sections carry a context menu, items carry a hover menu,
 * and `collapsed` switches to a 48px icon rail.
 * ───────────────────────────────────────────────────────── */

const ITEMS = [
  { key: "activity", label: "Home", section: "Workspace" },
  { key: "tasks", label: "Agent tasks", section: "Workspace", count: true },
  { key: "dashboard", label: "Inbox", section: "Workspace" },
  { key: "spaces", label: "Suppliers", section: "Objects", plus: true },
  { key: "analytics", label: "Inventory", section: "Objects" },
];

const ICON_PATHS: Record<string, React.ReactNode> = {
  activity: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  tasks: <g><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></g>,
  spaces: <g><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5M2 12l10 5 10-5" /></g>,
  dashboard: <g><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></g>,
  analytics: <g><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></g>,
  chat: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
};

function Icon({ kind }: { kind: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {ICON_PATHS[kind] ?? ICON_PATHS.chat}
    </svg>
  );
}

export interface NavItem {
  key: string;
  label: string;
  meta?: string;
  icon?: string;
  count?: number;
  sectionKey?: string;
  /** demo: hover-revealed plus glyph */
  plus?: boolean;
}

export interface NavSection {
  key: string;
  label: string;
  menu?: () => MenuItem[];
  /** Clicking the section header switches to it (e.g. project filter) */
  onSelect?: () => void;
}

const DEMO_ITEMS: NavItem[] = ITEMS.map((item) => ({
  key: item.key,
  label: item.label,
  sectionKey: item.section,
  ...(item.plus ? { plus: true } : {}),
}));

export default function SidebarNav({
  demo = true,
  collapsed = false,
  onToggleCollapse,
  workspaceTitle = "Creamery Ops",
  workspaceSub = "Production Workspace",
  accentLabel = "New task",
  onAccent,
  searchPlaceholder = "搜索会话",
  items = DEMO_ITEMS,
  activeKey,
  onSelectItem,
  sections,
  itemMenu,
  onSearch,
}: {
  /** Demo nav (default) vs app-driven nav */
  demo?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  workspaceTitle?: string;
  workspaceSub?: string;
  accentLabel?: string;
  onAccent?: () => void;
  searchPlaceholder?: string;
  items?: NavItem[];
  activeKey?: string;
  onSelectItem?: (key: string) => void;
  sections?: NavSection[];
  itemMenu?: (key: string) => MenuItem[];
  onSearch?: (query: string) => void;
}) {
  const [activeInternal, setActiveInternal] = useState("tasks");
  const [hovered, setHovered] = useState<string | null>(null);
  const [box, setBox] = useState<{ top: number; height: number } | null>(null);
  const [query, setQuery] = useState("");
  const [badge, setBadge] = useState(4);
  /* Section folders the user has collapsed (by key). Default: all expanded. */
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    () => new Set(),
  );
  const navRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const searchRef = useRef<HTMLInputElement>(null);

  const active = demo ? activeInternal : (activeKey ?? "");

  const selectItem = (key: string) => {
    if (demo) {
      setActiveInternal(key);
    } else {
      onSelectItem?.(key);
    }
  };

  const accent = () => {
    if (demo) {
      setBadge((current) => current + 1);
      setActiveInternal("tasks");
    } else {
      onAccent?.();
    }
  };

  const onQueryChange = (value: string) => {
    setQuery(value);
    if (!demo) onSearch?.(value);
  };

  const matches = (item: NavItem) =>
    demo || !query.trim() ? true : item.label.toLowerCase().includes(query.trim().toLowerCase());

  /* demo sections come from the items; app sections from props */
  const renderedSections: {
    key: string;
    label: string;
    menu?: () => MenuItem[];
    onSelect?: () => void;
    items: NavItem[];
  }[] =
    demo
      ? ["Workspace", "Objects"].map((section) => ({
          key: section,
          label: section,
          items: items.filter((item) => item.sectionKey === section).filter(matches),
        }))
      : (() => {
          const groups: { key: string; label: string; menu?: () => MenuItem[]; items: NavItem[] }[] =
            (sections ?? []).map((section) => ({
              ...section,
              items: items.filter((item) => item.sectionKey === section.key).filter(matches),
            }));
          const known = new Set((sections ?? []).map((s) => s.key));
          const rest = items.filter((item) => !item.sectionKey || !known.has(item.sectionKey)).filter(matches);
          if (rest.length > 0) groups.push({ key: "__other", label: "其他", items: rest });
          return groups;
        })();

  /* Whether any session survives the current search query — used to show a
     "no results" state instead of a silent blank list. */
  const hasFilteredItems = renderedSections.some((s) => s.items.length > 0);

  const activeSectionKey = items.find((i) => i.key === active)?.sectionKey;

  /* Which section headers to render. Empty, non-active groups are hidden to cut
     visual noise — a group only shows its header when it has sessions or is the
     one currently in view. */
  const visibleSections = renderedSections.filter(
    (s) => s.items.length > 0 || s.key === activeSectionKey,
  );

  const toggleSection = (key: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /* A section is only collapsed when the user collapsed it AND there is no
     active search — searching always shows every matching session. */
  const sectionCollapsed = (key: string) =>
    collapsedSections.has(key) && !query.trim();

  /* The folder holding the active session auto-expands so the current
     selection is never hidden inside a collapsed group. */
  useEffect(() => {
    if (!activeSectionKey) return;
    setCollapsedSections((prev) => {
      if (!prev.has(activeSectionKey)) return prev;
      const next = new Set(prev);
      next.delete(activeSectionKey);
      return next;
    });
  }, [activeSectionKey]);

  useLayoutEffect(() => {
    const container = navRef.current;
    const target = itemRefs.current[hovered ?? active];
    if (!container) return;
    /* Item vanished (deleted / folder collapsed): drop the highlight instead
       of leaving a stale box floating over the list. */
    if (!target) {
      setBox(null);
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    setBox({
      top: targetRect.top - containerRect.top,
      height: targetRect.height,
    });
  }, [hovered, active, collapsed, query, items, sections, collapsedSections]);

  /* The "/" kbd hint in the search field only makes sense if "/" actually
     focuses it — wire it up globally (but never steal focus from an input). */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const renderRow = (item: NavItem) => {
    const isActive = item.key === active;
    const menu = !demo && itemMenu ? itemMenu(item.key) : [];

    const row = (
      <button
        key={item.key}
        ref={(el) => {
          itemRefs.current[item.key] = el;
        }}
        type="button"
        onMouseEnter={() => setHovered(item.key)}
        onFocus={() => setHovered(item.key)}
        onBlur={() => setHovered(null)}
        onClick={() => selectItem(item.key)}
        aria-current={isActive ? "page" : undefined}
        aria-label={collapsed ? item.label : undefined}
        className={`group relative z-10 flex w-full items-center rounded-[7px] px-2 py-1.5 text-left
          transition-[color,transform] duration-150 active:scale-[0.96] ${
            collapsed ? "justify-center" : "gap-2"
          }`}
      >
        <span className={isActive ? "text-ink" : "text-ink-2"}>
          <Icon kind={item.icon ?? (demo ? item.key : "chat")} />
        </span>
        {!collapsed && (
          <>
            <span
              title={item.label}
              className={`min-w-0 flex-1 truncate text-[13px] transition-colors duration-150
                ${isActive ? "font-medium text-ink" : "text-ink-2"}`}
            >
              {item.label}
            </span>
            {item.meta && (
              <span className="shrink-0 text-[11px] text-ink-2 tabular-nums">{item.meta}</span>
            )}
            {item.plus && (
              <span
                className="flex size-4.5 items-center justify-center rounded-[5px] text-ink-3 opacity-0
                  transition-[background-color,color,opacity] duration-100 group-hover:opacity-100 hover:bg-line/70 hover:text-ink-2"
                style={isActive ? { opacity: 1 } : undefined}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </span>
            )}
            {item.count !== undefined && (
              <span
                key={`${item.key}-${item.count}`}
                className={`flex h-4.5 min-w-4.5 items-center justify-center rounded-full px-1 text-[10.5px] font-semibold tabular-nums ${
                  isActive ? "bg-surface text-ink-2 shadow-hairline" : "bg-accent-tint text-accent-ink"
                }`}
                style={{ animation: "pop-in 250ms cubic-bezier(0.23,1,0.32,1) both" }}
              >
                {item.count}
              </span>
            )}
            {demo && item.key === "tasks" && item.count === undefined && (
              <span
                key={badge}
                className={`flex h-4.5 min-w-4.5 items-center justify-center rounded-full px-1 text-[10.5px] font-semibold tabular-nums ${
                  isActive ? "bg-surface text-ink-2 shadow-hairline" : "bg-accent-tint text-accent-ink"
                }`}
                style={{ animation: "pop-in 250ms cubic-bezier(0.23,1,0.32,1) both" }}
              >
                {badge}
              </span>
            )}
          </>
        )}
      </button>
    );

    if (collapsed) {
      const wrapped = menu.length > 0 ? (
        <Dropdown key={item.key} trigger={["contextMenu"]} menu={toMenuProps(menu)}>
          {row}
        </Dropdown>
      ) : (
        row
      );
      return (
        <Tooltip
          key={item.key}
          title={item.label}
          placement="right"
          mouseEnterDelay={0}
          mouseLeaveDelay={0}
        >
          {wrapped}
        </Tooltip>
      );
    }

    if (menu.length > 0) {
      /* Right-click on the row opens the per-session menu (rename/delete);
         left-click still selects. Same interaction as the collapsed rail. */
      return (
        <Dropdown key={item.key} trigger={["contextMenu"]} menu={toMenuProps(menu)}>
          {row}
        </Dropdown>
      );
    }

    return row;
  };

  return (
    <div
      data-sidebar
      className={`flex flex-col ${collapsed ? "w-12" : "w-60"} ${
        demo ? "rounded-card bg-surface p-2 shadow-raised" : "min-h-0 flex-1"
      }`}
    >
      {/* workspace row — identity block. Expanded: the only action is the
          collapse chevron (a button nested in a button would be invalid HTML).
          Collapsed: the avatar itself becomes the expand control, so the icon
          rail is never left without a way back (Ctrl/Cmd+B also works). */}
      {collapsed ? (
        <Tooltip title={workspaceTitle} placement="right" mouseEnterDelay={0} mouseLeaveDelay={0}>
          <button
            type="button"
            aria-label="展开侧栏"
            onClick={() => onToggleCollapse?.()}
            className="mb-2 flex w-full items-center justify-center rounded-control p-1.5"
          >
            <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-[8px] bg-surface shadow-hairline">
              <img src={deepseekLogo} alt="" draggable={false} style={{ height: 18, width: "auto" }} />
            </span>
          </button>
        </Tooltip>
      ) : (
        <Tooltip title={workspaceTitle} placement="right" mouseEnterDelay={0} mouseLeaveDelay={0}>
          <div className="mb-2 flex w-full items-center gap-2.5 rounded-control p-1.5 text-left">
            <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-[8px] bg-surface shadow-hairline">
              <img src={deepseekLogo} alt="" draggable={false} style={{ height: 18, width: "auto" }} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium leading-tight text-ink">{workspaceTitle}</span>
              <span className="block truncate text-[11px] leading-tight text-ink-3">{workspaceSub}</span>
            </span>
            {!demo && (
              <button
                type="button"
                aria-label="折叠侧栏"
                onClick={() => onToggleCollapse?.()}
                className="flex size-5 shrink-0 items-center justify-center rounded-[5px] text-ink-3 hover:bg-hover-2 hover:text-ink"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
            )}
            {demo && (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 15l5 5 5-5M7 9l5-5 5 5" />
              </svg>
            )}
          </div>
        </Tooltip>
      )}

      {/* quick search */}
      {!collapsed && (
        <label className="mb-2 flex h-8 items-center gap-2 rounded-control bg-inset px-2.5 shadow-hairline">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={demo ? "Quick search" : searchPlaceholder}
            aria-label={demo ? "Quick search" : searchPlaceholder}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-3"
          />
          <kbd className="flex size-4.5 items-center justify-center rounded-[5px] bg-surface text-[10px] text-ink-3 shadow-hairline">
            /
          </kbd>
        </label>
      )}

      {/* accent action */}
      <Tooltip
        title={accentLabel}
        placement="right"
        mouseEnterDelay={0}
        mouseLeaveDelay={0}
      >
        <button
          type="button"
          onClick={accent}
          aria-label={collapsed ? accentLabel : undefined}
          style={{ boxSizing: "border-box", width: "calc(100% - 16px)" }}
          className={`mb-2 ml-2 mr-2 flex h-8 items-center justify-center gap-2.5
            rounded-control border border-line-strong px-2.5 text-[13px] font-medium leading-none
            text-accent transition-[background-color,transform] duration-100 hover:bg-accent-tint
            active:scale-[0.96]`}
        >
          {!collapsed && <span className="min-w-0 truncate">{accentLabel}</span>}
          <span className="flex size-4.5 shrink-0 items-center justify-center rounded-full bg-accent text-white shadow-btn">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
        </button>
      </Tooltip>

      {/* items */}
      <div
        ref={navRef}
        onMouseLeave={() => setHovered(null)}
        className="relative flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto"
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 rounded-[7px] bg-hover"
          style={{
            top: box?.top ?? 0,
            height: box?.height ?? 0,
            opacity: box ? 1 : 0,
            transition:
              "top 220ms cubic-bezier(0.23,1,0.32,1), height 220ms cubic-bezier(0.23,1,0.32,1), opacity 150ms ease",
          }}
        />
        {visibleSections.map((section) =>
          collapsed ? (
            <div key={section.key} className="flex flex-col gap-px">
              {section.items.map((item) => renderRow(item))}
            </div>
          ) : (
            <div key={section.key}>
              <div className="flex items-center gap-0.5 px-1 pb-1 pt-1">
                <button
                  type="button"
                  aria-label={
                    sectionCollapsed(section.key)
                      ? `展开${section.label}`
                      : `收起${section.label}`
                  }
                  aria-expanded={!sectionCollapsed(section.key)}
                  onClick={() => toggleSection(section.key)}
                  className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[4px] text-ink-3 transition-colors duration-100 hover:bg-hover-2 hover:text-ink"
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{
                      transform: sectionCollapsed(section.key)
                        ? "rotate(-90deg)"
                        : "rotate(0deg)",
                      transition: "transform 150ms ease",
                    }}
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={
                    section.onSelect ??
                    (() => toggleSection(section.key))
                  }
                  aria-expanded={
                    section.onSelect
                      ? undefined
                      : !sectionCollapsed(section.key)
                  }
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 truncate text-left text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-2 transition-colors duration-100 hover:text-ink"
                >
                  <span className="truncate">{section.label}</span>
                  <span className="shrink-0 rounded-full bg-hover px-1.5 text-[10px] font-normal leading-none tracking-normal text-ink-3 tabular-nums">
                    {section.items.length}
                  </span>
                </button>
                {section.menu && (
                  <Dropdown trigger={["click", "contextMenu"]} menu={toMenuProps(section.menu())}>
                    <button
                      type="button"
                      aria-label={`${section.label} 菜单`}
                      className="flex size-4 cursor-pointer items-center justify-center rounded-[4px] hover:bg-hover-2 hover:text-ink"
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                        <circle cx="5" cy="12" r="1.6" />
                        <circle cx="12" cy="12" r="1.6" />
                        <circle cx="19" cy="12" r="1.6" />
                      </svg>
                    </button>
                  </Dropdown>
                )}
              </div>
              {!sectionCollapsed(section.key) && (
                <div className="flex flex-col gap-px">
                  {section.items.map((item) => renderRow(item))}
                </div>
              )}
            </div>
          ),
        )}
        {!demo && !collapsed && items.length === 0 && (
          <div className="px-2 py-6 text-center text-[12px] text-ink-2">
            暂无会话
            <br />
            点击上方「新对话」开始
          </div>
        )}
        {!demo && !collapsed && items.length > 0 && !hasFilteredItems && (
          <div className="px-2 py-6 text-center text-[12px] text-ink-2">
            无匹配的会话
          </div>
        )}
      </div>
    </div>
  );
}
