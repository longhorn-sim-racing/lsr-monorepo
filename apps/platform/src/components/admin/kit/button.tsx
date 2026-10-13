import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        primary: "border-primary bg-primary font-semibold text-primary-foreground hover:bg-[#F27400]",
        secondary: "border-input bg-card text-foreground hover:bg-accent",
        ghost: "border-transparent bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
        danger: "border-input bg-card text-tone-danger-foreground hover:border-tone-danger-foreground/40 hover:bg-tone-danger",
        "danger-solid": "border-tone-danger-foreground bg-tone-danger-foreground font-semibold text-white hover:bg-[#991B1B]",
      },
      size: {
        sm: "h-7 px-2.5 text-xs",
        md: "h-8 px-3 text-[13px]",
        icon: "size-7 p-0 text-[13px]",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
)

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    /** Render the child (e.g. a Link) with button styles */
    asChild?: boolean
    /** Shows a spinner and disables the button */
    pending?: boolean
  }

/** The admin button. Primary is orange with dark text; use it once per view for the main action. */
export function Button({ className, variant, size, asChild = false, pending = false, disabled, type, children, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button"
  return (
    <Comp
      // A plain button unless it says otherwise, so Cancel and helper buttons inside forms never submit them
      type={asChild ? type : (type ?? "button")}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={asChild ? undefined : disabled || pending}
      aria-busy={pending || undefined}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {pending && <Loader2 className="animate-spin" aria-hidden />}
          {children}
        </>
      )}
    </Comp>
  )
}

/** A square icon-only button; `label` becomes its accessible name and tooltip. */
export function IconButton({
  label,
  className,
  variant = "ghost",
  ...props
}: Omit<ButtonProps, "size" | "children"> & { label: string; children: React.ReactNode }) {
  return <Button size="icon" variant={variant} aria-label={label} title={label} className={className} {...props} />
}
