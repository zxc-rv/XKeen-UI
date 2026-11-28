import { cn } from '@/lib/utils'
import { IconLoader2 } from '@tabler/icons-react'
import { motion } from 'framer-motion'

function Spinner({ variant = 'spinner', className, ...props }: React.ComponentProps<'svg'> & { variant?: 'spinner' | 'dots' }) {
  if (variant === 'dots') {
    return (
      <span role="status" aria-label="Loading" className={cn('inline-flex items-center gap-0.5', className)}>
        {[0, 0.15, 0.3].map((delay) => (
          <motion.span
            key={delay}
            className="bg-muted-foreground size-1 rounded-full"
            animate={{ y: [0, -5, 0, 0] }}
            transition={{ duration: 1, delay, times: [0, 0.3, 0.6, 1], ease: ['easeInOut', 'easeInOut', 'linear'], repeat: Infinity }}
          />
        ))}
      </span>
    )
  }
  return <IconLoader2 role="status" aria-label="Loading" className={cn('size-4 animate-spin', className)} {...props} />
}

export { Spinner }
