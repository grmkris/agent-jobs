import { Shot } from './Shot.tsx'

/** A delivered page in a browser window, with its real address in the bar. */
export function BrowserPreview({
  shot,
  url,
  alt,
  eager,
}: {
  shot: string
  url: string
  alt: string
  eager?: boolean | undefined
}) {
  return (
    <div className="sp-browser">
      <div className="sp-browser-bar">
        <span className="sp-lights" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="sp-address">{url.replace(/^https:\/\//, '')}</span>
      </div>
      <div className="sp-browser-page">
        <Shot src={shot} width={800} height={450} alt={alt} eager={eager} />
      </div>
    </div>
  )
}
