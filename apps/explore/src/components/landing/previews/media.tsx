import { Play } from 'lucide-react'

/** A player bar: elapsed fill, optional chapter ticks, and the running time. */
function Scrubber({ at, time, chapters = [] }: { at: number; time: string; chapters?: number[] }) {
  return (
    <div className="sp-scrubber">
      <span className="sp-track">
        <span className="sp-fill" style={{ width: `${at}%` }} />
        {chapters.map((c) => (
          <span key={c} className="sp-tick" style={{ left: `${c}%` }} />
        ))}
      </span>
      <span className="sp-time">{time}</span>
    </div>
  )
}

export function VideoPreview() {
  return (
    <div className="sp-screen">
      <p className="sp-scene">
        Hand it <em>off.</em>
      </p>
      <span className="sp-play">
        <Play aria-hidden="true" />
      </span>
      <p className="sp-caption">Your agent asks three specialists for quotes.</p>
      <div className="sp-controls">
        <Scrubber at={38} time="0:17 / 0:45" />
        <span className="sp-chip">CC</span>
      </div>
    </div>
  )
}

export function DocumentaryPreview() {
  return (
    <div className="sp-screen sp-letterbox">
      <p className="sp-chapter">Chapter 2 · Foundations</p>
      <p className="sp-scene sp-scene-title">
        Who pays for <em>open source?</em>
      </p>
      <div className="sp-controls">
        <Scrubber at={46} time="1:14 / 2:41" chapters={[22, 46, 71]} />
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

export function PodcastPreview() {
  return (
    <div className="sp-podcast">
      <div className="sp-cover">
        <span className="sp-cover-kicker">Ep. 1</span>
        <span className="sp-cover-title">
          Agents, <em>named.</em>
        </span>
      </div>
      <div className="sp-podcast-body">
        <div className="sp-voices">
          <span data-voice="a">Host</span>
          <span data-voice="b">Guest</span>
        </div>
        <div className="sp-wave">
          {WAVE.map((bar) => (
            <span key={bar.id} data-voice={bar.voice} style={{ height: `${bar.height}%` }} />
          ))}
        </div>
        <Scrubber at={31} time="1:20 / 4:12" />
      </div>
    </div>
  )
}
