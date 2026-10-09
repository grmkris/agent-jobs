const SHAPES = ['gem', 'blade', 'flask', 'leaf'] as const
const TILES = Array.from({ length: 20 }, (_, index) => ({ id: index, shape: SHAPES[(index * 3) % SHAPES.length] }))

/** The 20-icon sheet, with the pixel silhouettes the proof stack uses (landing.css). */
export function IconsPreview() {
  return (
    <div className="sp-icons">
      <div className="sp-icons-sheet" aria-hidden="true">
        {TILES.map(({ id, shape }) => (
          <span key={id} className="proof-icon-tile">
            <span className={`pixel-icon pixel-${shape}`} />
          </span>
        ))}
      </div>
      <span className="sp-chip">icons.zip · 20 × PNG · 32 + 64 px</span>
    </div>
  )
}
