import * as React from 'react'

function getRenderProp<T>(asChild: boolean | undefined, children: React.ReactNode, render?: T) {
  if (asChild && React.isValidElement(children)) {
    return children
  }

  return render
}

function getRenderChildren(asChild: boolean | undefined, children: React.ReactNode) {
  return asChild && React.isValidElement(children) ? undefined : children
}

export { getRenderChildren, getRenderProp }
