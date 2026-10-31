import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Иконка очистки поля: залитый круг с крестиком на фоне.
 * Круг наследует текущий цвет текста (muted / destructive при hover),
 * а крестик рисуется цветом фона инпута, поэтому читается даже при маленьком размере.
 */
function ClearIcon({ className, size = 14, ...props }: React.SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      width={size}
      height={size}
      className={cn('shrink-0', className)}
      aria-hidden="true"
      {...props}
    >
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      <path
        d="M8.5 8.5l7 7M15.5 8.5l-7 7"
        stroke="var(--color-input-background)"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

export { ClearIcon }
