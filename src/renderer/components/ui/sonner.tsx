import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, toast, type ToasterProps } from "sonner"

// This app themes via <html data-theme="…"> (see App.tsx), not next-themes.
// The CSS-variable style block below already resolves per-theme, so sonner
// only needs to not force its own palette.
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    // Click anywhere on a toast to dismiss it (buttons keep their own click).
    // Sonner doesn't expose per-toast ids in the DOM, so this dismisses the
    // stack — fine in practice, there's rarely more than one.
    <div
      onClick={(e) => {
        const el = e.target as HTMLElement;
        if (el.closest("[data-sonner-toast]") && !el.closest("button")) toast.dismiss();
      }}
    >
    <Sonner
      theme={(document.documentElement.dataset.theme as ToasterProps["theme"]) ?? "light"}
      // richColors activates the per-type --success-*/--error-*/--warning-*
      // vars below (without it every type renders on --normal-bg).
      richColors
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
          // Severity toasts use the app's status-pill language: soft tinted
          // surface + colored title (like the green "Update available" pill).
          // Plain toasts stay on the popover surface.
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          // Tint mixed over the popover surface so toasts stay OPAQUE — they
          // float over content (the raw -soft tokens are translucent in dark).
          "--success-bg": "color-mix(in srgb, var(--success) 10%, var(--popover))",
          "--success-text": "var(--success)",
          "--success-border": "color-mix(in srgb, var(--success) 25%, transparent)",
          "--error-bg": "color-mix(in srgb, var(--destructive) 9%, var(--popover))",
          "--error-text": "var(--destructive)",
          "--error-border": "color-mix(in srgb, var(--destructive) 25%, transparent)",
          "--warning-bg": "color-mix(in srgb, var(--warning) 10%, var(--popover))",
          "--warning-text": "var(--warning)",
          "--warning-border": "color-mix(in srgb, var(--warning) 28%, transparent)",
          "--border-radius": "10px",
        } as React.CSSProperties
      }
      toastOptions={{
        style: { fontSize: "13px", fontFamily: "Inter, sans-serif" },
        classNames: {
          // Top-align the icon with the title (sonner centers it against the
          // whole block, which reads badly on multi-line toasts) and balance
          // the side padding.
          toast: "!items-start !gap-2.5 !px-3.5 !py-3",
          icon: "!mt-px !ml-0",
          title: "!font-semibold",
          description: "!text-muted-foreground !leading-snug !mt-0.5",
          actionButton: "!bg-primary !text-primary-foreground",
        },
      }}
      {...props}
    />
    </div>
  )
}

export { Toaster }
