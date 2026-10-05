// shadcn base-nova on Base UI, vendored from ~/code/myplan/apps/web/src/components/ui; edit here, there is no upstream sync.
import { cn } from '../../lib/cn.ts'
import { Loader2Icon } from "lucide-react"

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon data-slot="spinner" role="status" aria-label="Loading" className={cn("size-4 animate-spin", className)} {...props} />
  )
}

export { Spinner }
