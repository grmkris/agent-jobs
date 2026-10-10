import { Play } from 'lucide-react'
import { Shot } from './Shot.tsx'

/** A player bar at the start, with the delivery's real running time. */
function Scrubber({ duration }: { duration: string }) {
  return (
    <div className="sp-scrubber">
      <span className="sp-track">
        <span className="sp-fill" style={{ width: '0%' }} />
      </span>
      <span className="sp-time">0:00 / {duration}</span>
    </div>
  )
}

/** A video as delivered: its own poster frame under a paused player. */
export function PlayerPreview({
  shot,
  duration,
  alt,
  eager,
}: {
  shot: string
  duration: string
  alt: string
  eager?: boolean | undefined
}) {
  return (
    <div className="sp-screen sp-player">
      <Shot src={shot} width={800} height={450} alt={alt} eager={eager} />
      <span className="sp-play">
        <Play aria-hidden="true" />
      </span>
      <div className="sp-controls">
        <Scrubber duration={duration} />
      </div>
    </div>
  )
}

/** Two voices take turns; the bars alternate between them. */
const WAVE = Array.from({ length: 34 }, (_, i) => ({
  id: i,
  height: 22 + Math.round(Math.abs(Math.sin(i * 1.7) + Math.sin(i * 0.6)) * 34),
  voice: Math.floor(i / 6) % 2 === 0 ? 'a' : 'b',
}))

/** An episode as delivered: its own cover beside a two-voice waveform and its running time. */
export function PodcastPreview({
  cover,
  duration,
  alt,
  eager,
}: {
  cover: string
  duration: string
  alt: string
  eager?: boolean | undefined
}) {
  return (
    <div className="sp-podcast">
      <div className="sp-cover">
        <Shot src={cover} width={480} height={480} alt={alt} eager={eager} />
      </div>
      <div className="sp-podcast-body">
        <div className="sp-wave" aria-hidden="true">
          {WAVE.map((bar) => (
            <span key={bar.id} data-voice={bar.voice} style={{ height: `${bar.height}%` }} />
          ))}
        </div>
        <Scrubber duration={duration} />
      </div>
    </div>
  )
}
