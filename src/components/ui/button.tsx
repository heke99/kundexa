import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost"; size?: "sm" | "md" };

export function Button({ className, variant = "primary", size = "md", ...props }: Props) {
  return <button className={cn("button", `button-${variant}`, `button-${size}`, className)} {...props} />;
}
