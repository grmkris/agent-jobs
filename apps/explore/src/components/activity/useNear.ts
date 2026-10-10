import { useEffect, useRef, useState } from 'react'

/**
 * Whether the element has come within 200 px of the viewport, and stays true after: a row reads what it shows (its
 * delivery's preview) only once someone could see it, so a long Activity list never reads every row at once.
 */
export function useNear<T extends Element>() {
  const ref = useRef<T>(null)
  const [near, setNear] = useState(false)
  useEffect(() => {
    const node = ref.current
    if (node === null || near) return
    const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting === true && setNear(true), {
      rootMargin: '200px',
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [near])
  return [ref, near] as const
}
