/** A real image of the delivery, sized for its frame; the hero's front card loads first, the rest when near. */
export function Shot({
  src,
  width,
  height,
  alt,
  eager = false,
}: {
  src: string
  width: number
  height: number
  alt: string
  eager?: boolean | undefined
}) {
  return (
    <img
      className="sp-shot"
      src={src}
      width={width}
      height={height}
      alt={alt}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      fetchPriority={eager ? 'high' : 'auto'}
    />
  )
}
