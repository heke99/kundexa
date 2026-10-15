"use client";

import { useSyncExternalStore, type ReactNode } from "react";

const subscribe = () => () => {};
const isFramed = () => window.self !== window.top;

/** Presentation only: route authorization always runs on the server first. */
export function ContractFrameShell({ children, content, initiallyFramed }: {
  children: ReactNode;
  content: ReactNode;
  initiallyFramed: boolean;
}) {
  const framed = useSyncExternalStore(subscribe, isFramed, () => initiallyFramed);
  return framed ? <main className="page-content">{content}</main> : children;
}
