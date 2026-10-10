import { Shot } from './Shot.tsx'

const LANGUAGES = ['EN', 'ES', 'DE', 'JA']

/**
 * A delivered document on a sheet of paper that runs off the frame: its top as captured. A translation carries its
 * languages as tabs above it.
 */
export function PaperPreview({
  shot,
  alt,
  languages = false,
  eager,
}: {
  shot: string
  alt: string
  languages?: boolean
  eager?: boolean | undefined
}) {
  return (
    <div className="sp-paper sp-paper-shot">
      {languages && (
        <div className="sp-tabs" aria-hidden="true">
          {LANGUAGES.map((lang) => (
            <span key={lang}>{lang}</span>
          ))}
        </div>
      )}
      <Shot src={shot} width={780} height={520} alt={alt} eager={eager} />
    </div>
  )
}
