"use client";

import { useLayoutEffect, useRef } from "react";

/** Textarea that grows with its content (up to maxHeight), so long instructions stay readable. */
export function AutoTextarea({ value, onChange, minRows = 3, maxHeight = 520, ...rest }: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value"> & {
  value: string;
  onChange: (v: string) => void;
  minRows?: number;
  maxHeight?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(maxHeight, el.scrollHeight + 2)}px`;
    el.style.overflowY = el.scrollHeight + 2 > maxHeight ? "auto" : "hidden";
  }, [value, maxHeight]);
  return <textarea ref={ref} rows={minRows} value={value} onChange={e => onChange(e.target.value)} {...rest} />;
}
