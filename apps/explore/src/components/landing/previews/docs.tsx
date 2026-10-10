import { Shot } from './Shot.tsx'

/** A delivered document (a memo, a proposal) on a sheet of paper that runs off the frame: its top as captured. */
export function PaperPreview({ shot, alt, eager }: { shot: string; alt: string; eager?: boolean | undefined }) {
  return (
    <div className="sp-paper sp-paper-shot">
      <Shot src={shot} width={780} height={520} alt={alt} eager={eager} />
    </div>
  )
}
