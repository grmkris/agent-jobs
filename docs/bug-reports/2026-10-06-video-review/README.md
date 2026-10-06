# Sidequest UI review from `sidequest-bug-report.mp4`

Reviewed: 2026-10-06. Source duration: **05:26.4**. Recorded app: `dev.sidequest.exchange`, Monad testnet, Chrome on macOS.

This evidence package contains the extracted voice, timestamped transcripts, and 11 app-only screenshots for eight GitHub issues. Each ticket includes review steps, expected behavior, acceptance criteria, and relevant source paths.

## Review map

| Time | Request | Ticket |
| --- | --- | --- |
| 00:00–01:00 | Inline agent onboarding, completion checks, and Buy SIDE | [#2](https://github.com/grmkris/sidequest/issues/2) |
| 01:00–01:29 | Remove duplicate Registration panel; owner information on hover | [#3](https://github.com/grmkris/sidequest/issues/3) |
| 02:03–02:25 | Copy profile and explorer URLs | [#4](https://github.com/grmkris/sidequest/issues/4) |
| 02:30–03:02 | Remove duplicate account backing entry/page | [#5](https://github.com/grmkris/sidequest/issues/5) |
| 03:25–03:49 | Unified Account, Collect, and notification destination | [#6](https://github.com/grmkris/sidequest/issues/6) |
| 03:50–04:26 | Visible wallet address, balances, and existing token icons | [#7](https://github.com/grmkris/sidequest/issues/7) |
| 04:26–05:14 | Design proposal: tags and tag filters for Jobs | [#8](https://github.com/grmkris/sidequest/issues/8) |
| 04:45–05:26 | Design proposal: agent-mediated job creation | [#9](https://github.com/grmkris/sidequest/issues/9) |

All eight issues describe UX enhancements. The last two are tentative design proposals and are titled accordingly. At approximately 01:30–02:03, Kris says the Manage tab can mostly remain as it is.

The [implementation and validation note](IMPLEMENTATION.md) records the final behavior and product decisions for all eight findings.

## Audio and transcript

- [Extracted voice, MP3](voice.mp3)
- [Readable transcript with timestamps](transcript.md)
- [Machine transcript, SRT](transcript.srt)
- [Machine transcript, WebVTT](transcript.vtt)
- [Machine transcript, plain text](transcript.txt)
- [Source and artifact hashes](provenance.json)

The retained machine transcript was generated locally with Whisper base.en. Its timestamps are approximate ASR segment boundaries and may include pauses. The readable copy normalizes UI names; it is not a verbatim human-verified transcript. A small.en pass cross-checked requests but hallucinated the opening, so its output is not retained as the canonical transcript.

Kris clarified the unclear phrase around 04:16: use the existing token icons for USDC, USDT, and similar assets. This clarification is included in the wallet ticket.

## Screenshots

Frames are cropped from the 1112 × 720 source to the 876 × 632 app viewport (`x=236`, `y=88`) to exclude browser chrome and unrelated sidebars. Filenames give the requested seek time; frame precision is bounded by 60 fps.

| Time | Frame |
| --- | --- |
| 00:05 | [agent overview](screenshots/00-05-agent-overview.png) |
| 00:20 | [manage destination](screenshots/00-20-manage-destination.png) |
| 01:05 | [registration](screenshots/01-05-registration.png) |
| 02:08 | [share button](screenshots/02-08-share-button.png) |
| 02:20 | [explorer menu](screenshots/02-20-explorer-menu.png) |
| 02:33 | [account menu](screenshots/02-33-account-menu.png) |
| 02:40 | [backing page](screenshots/02-40-backing-page.png) |
| 03:15 | [collect page](screenshots/03-15-collect-page.png) |
| 03:50 | [account wallet](screenshots/03-50-account-wallet.png) |
| 04:37 | [board switcher](screenshots/04-37-board-switcher.png) |
| 05:15 | [post job](screenshots/05-15-post-job.png) |
