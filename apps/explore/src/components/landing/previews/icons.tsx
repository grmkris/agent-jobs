/** The pack as delivered: its 32 px PNGs on a transparency checkerboard, drawn at twice their size, pixel for pixel. */
export function IconsPreview({ icons }: { icons: readonly string[] }) {
  return (
    <div className="sp-icons">
      <div className="sp-icons-sheet" aria-hidden="true">
        {icons.map((src) => (
          <span key={src} className="proof-icon-tile">
            <img className="sp-icon" src={src} width={32} height={32} alt="" />
          </span>
        ))}
      </div>
      <span className="sp-chip">icons.zip · {icons.length} × PNG · 32 + 64 px</span>
    </div>
  )
}
