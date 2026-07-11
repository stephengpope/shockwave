import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

// This app themes via <html data-theme="…"> (see App.tsx), not next-themes.
// The CSS-variable style block below already resolves per-theme, so sonner
// only needs to not force its own palette.
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme={(document.documentElement.dataset.theme as ToasterProps["theme"]) ?? "light"}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          // One popup language: popover surface + hairline border for every
          // toast; only the icon carries the severity color (app tokens).
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--success-bg": "var(--popover)",
          "--success-text": "var(--popover-foreground)",
          "--success-border": "var(--border)",
          "--error-bg": "var(--popover)",
          "--error-text": "var(--popover-foreground)",
          "--error-border": "var(--border)",
          "--warning-bg": "var(--popover)",
          "--warning-text": "var(--popover-foreground)",
          "--warning-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        style: { fontSize: "13px", fontFamily: "Inter, sans-serif" },
        classNames: {
          // Severity lives in the icon color only ([data-type] sits on the
          // toast <li>, the icon div is a descendant).
          icon: "[[data-type=success]_&]:text-success [[data-type=error]_&]:text-destructive [[data-type=warning]_&]:text-amber-500",
          description: "!text-muted-foreground",
          actionButton: "!bg-primary !text-primary-foreground",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
