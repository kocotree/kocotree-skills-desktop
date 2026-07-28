export type AppIconName =
  | "browse"
  | "upload"
  | "library"
  | "bell"
  | "search"
  | "clock"
  | "trend"
  | "hot"
  | "download"
  | "check"
  | "plus"
  | "folder"
  | "file"
  | "agents"
  | "claude"
  | "codex"
  | "more"
  | "logout";

const iconPaths: Record<AppIconName, React.ReactNode> = {
  browse: <><path d="M4 5.5h5v5H4zM15 5.5h5v5h-5zM4 15.5h5v5H4zM15 15.5h5v5h-5z" /></>,
  upload: <><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" /><path d="M5 14v5h14v-5" /></>,
  library: <><path d="M5 4h14v4H5zM5 10h14v4H5zM5 16h14v4H5z" /></>,
  bell: <><path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 5 2 5.5 2 5.5h-15s2-.5 2-5.5Z" /><path d="M10 19h4" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 4 4" /></>,
  clock: <><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3 2" /></>,
  trend: <><path d="m4 16 5-5 3.5 3.5L20 7" /><path d="M15 7h5v5" /></>,
  hot: <><path d="M13.4 3.5c.3 3-1.3 4.2-2.8 5.8-1.2 1.3-1.8 2.4-1.2 4.2.7-1.4 1.7-2.2 3-2.7-.2 1.8.8 2.8 2 4 1.1 1.1 1.6 2.4 1.4 4-4.7-.5-7.8-3.5-7.8-7.7 0-3.3 1.9-6.4 5.3-8.8Z" /></>,
  download: <><path d="M12 4v10m0 0 4-4m-4 4-4-4" /><path d="M5 18.5h14" /></>,
  check: <><path d="m5 12.5 4.2 4.2L19 7" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  folder: <><path d="M3.5 7.5h6l2-2h9v13h-17z" /></>,
  file: <><path d="M6.5 3.5h7l4 4v13h-11z" /><path d="M13.5 3.5v4h4" /></>,
  agents: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.2 2.3 3.3 5.1 3.3 8.5S14.2 18.2 12 20.5C9.8 18.2 8.7 15.4 8.7 12S9.8 5.8 12 3.5Z" /></>,
  claude: <><path d="M12 3.5v17M3.5 12h17M6 6l12 12M18 6 6 18" /><circle cx="12" cy="12" r="2.4" /></>,
  codex: <><path d="m12 3.5 7.4 4.25v8.5L12 20.5l-7.4-4.25v-8.5z" /><path d="m12 8 3.5 2v4L12 16l-3.5-2v-4z" /></>,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></>,
  logout: <><path d="M10 5H5v14h5" /><path d="M13 8l4 4-4 4M8 12h9" /></>,
};

/**
 * 功能说明：渲染应用内统一线性图标。
 * @param name - 需要展示的图标名称。
 * @param size - 图标宽高，单位为像素。
 * @returns 对应名称的 SVG 图标。
 */
export function AppIcon({ name, size = 18 }: { name: AppIconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      className="app-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {iconPaths[name]}
    </svg>
  );
}
