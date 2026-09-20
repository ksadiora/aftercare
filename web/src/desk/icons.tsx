import type { CSSProperties } from "react";
export type IconName = "phone" | "shield" | "arrow" | "send" | "mic" | "volume" | "muted" | "close" | "check" | "alert" | "message" | "settings" | "plus" | "clock" | "chevron" | "spark" | "lock" | "refresh";
const paths: Record<IconName, string> = {
  phone: "M8 3H5a2 2 0 0 0-2 2c0 9 7 16 16 16a2 2 0 0 0 2-2v-3l-5-2-2 3a13 13 0 0 1-7-7l3-2-2-5Z",
  shield: "M12 3 3.5 6v6c0 5 8.5 9 8.5 9s8.5-4 8.5-9V6L12 3Zm-4 9 3 3 5-6",
  arrow: "M4 12h16m-6-6 6 6-6 6", send: "m3 3 18 9-18 9 4-9-4-9Zm4 9h14",
  mic: "M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5Zm-3 6v1a6 6 0 0 0 12 0v-1m-6 7v4m-3 0h6",
  volume: "M11 4 6 8H3v8h3l5 4V4Zm4 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14",
  muted: "M11 4 6 8H3v8h3l5 4V4Zm5 5 6 6m0-6-6 6",
  close: "m6 6 12 12M6 18 18 6", check: "m5 12 4 4L19 6",
  alert: "m12 3 10 17H2L12 3Zm0 6v5m0 3h.01",
  message: "M21 11a9 9 0 0 1-9 9H3l1-5a9 9 0 1 1 17-4Zm-14 0h.01M12 11h.01M17 11h.01",
  settings: "M4 7h16M4 17h16M9 4v6m6 4v6", plus: "M12 5v14M5 12h14",
  clock: "M12 8v5l3 2m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", chevron: "m9 5 7 7-7 7",
  spark: "m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Z", lock: "M6 10h12v11H6V10Zm3 0V6a3 3 0 0 1 6 0v4m-3 5v2",
  refresh: "M20 8a8 8 0 1 0 0 8m0-13v5h-5",
};
export function Icon({ name, size = 20, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}><path d={paths[name]} /></svg>;
}
