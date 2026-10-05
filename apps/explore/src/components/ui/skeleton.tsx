// shadcn base-nova on Base UI, vendored from ~/code/myplan/apps/web/src/components/ui; edit here, there is no upstream sync.
import { cn } from '../../lib/cn.ts'

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
