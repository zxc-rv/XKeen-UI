import { cn } from '@/lib/utils'
/** Shared selector label used in both Add Rule and routing controls. */
export function SelectorLabel({ name, icon }: { name: string; icon?: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      {icon && (
        <img
          src={icon}
          alt=""
          className="size-4 shrink-0 rounded-sm object-contain"
          onError={(event) => {
            event.currentTarget.style.display = 'none'
          }}
        />
      )}
      <span
        className={cn(
          'truncate',
          name === 'REJECT' && 'text-red-600 dark:text-red-400',
          name === 'DIRECT' && 'text-green-700 dark:text-green-400'
        )}
      >
        {name}
      </span>
    </span>
  )
}
