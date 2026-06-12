import React, { memo } from 'react'

interface AuroraTextProps {
  children: React.ReactNode
  className?: string
  colors?: string[]
  speed?: number
}

export const AuroraText = memo(
  ({ children, className = '', colors = ['#FF0080', '#7928CA', '#0070F3', '#38bdf8'], speed = 1 }: AuroraTextProps) => {
    const text = typeof children === 'string' || typeof children === 'number' ? String(children) : ''
    const gradientStyle = {
      backgroundImage: `linear-gradient(135deg, ${colors.join(', ')}, ${colors[0]})`,
      WebkitBackgroundClip: 'text',
      WebkitTextFillColor: 'transparent',
      animationDuration: `${12 / speed}s`,
      animationTimingFunction: 'steps(60)',
    }

    return (
      <span className={`relative inline-block ${className}`} data-text={text}>
        <span className="sr-only">{children}</span>
        <span
          className="animate-aurora relative bg-size-[200%_auto] bg-clip-text text-transparent"
          style={gradientStyle}
          aria-hidden="true"
        >
          {children}
        </span>
      </span>
    )
  }
)

AuroraText.displayName = 'AuroraText'
