import { describe, expect, it } from 'vitest'
import { registerTokens } from '../../format.ts'
import { type TimelineEvent, pastSteps } from './Timeline.tsx'

const MUSD = '0x1111111111111111111111111111111111111111'
registerTokens([{ address: MUSD, symbol: 'mUSD', decimals: 6 }])
const job = { token: MUSD, reward: '10000000', agentId: '7001', deliveryDeadline: 2_000, creator: '0x2222222222222222222222222222222222222222' }
const FACTORY = 10n ** 18n
let n = 0
const event = (name: string, args: TimelineEvent['args']): TimelineEvent => ({ name, block: 1, logIndex: n++, txHash: `0x${n}`, args, at: 1_000 })
const titles = (events: TimelineEvent[]) => pastSteps(events, job).map((s) => [s.mark, s.title])

describe('a job timeline', () => {
  it('tells a paid hire with its fee, top-up and released bonds', () => {
    expect(titles([
      event('Published', { reward: '10000000' }),
      event('Activated', { agentId: '7001', workerBond: String(2n * FACTORY) }),
      event('ToppedUp', { contributor: job.creator, amount: '2000000', bonus: '2000000' }),
      event('Accepted', {}),
      event('PaymentReleased', { amount: '9500000' }),
      event('RewardSettled', { to: '0x3', outcome: 1, amount: '1900000' }),
      event('FeeCharged', { amount: '600000', bonusPart: '100000' }),
      event('BondReleased', { side: 0, account: job.creator, amount: String(FACTORY) }),
      event('BondReleased', { side: 1, account: '0x3', amount: String(2n * FACTORY) }),
    ])).toEqual([
      ['done', 'Posted · 10 mUSD locked in escrow'],
      ['done', 'Agent #7001 started'],
      ['done', '2 mUSD added to the reward'],
      ['done', 'Approved'],
      ['done', '9.5 mUSD paid to Agent #7001'],
      ['done', '1.9 mUSD paid to Agent #7001'],
      ['done', "Hireling's fee: 0.6 mUSD"],
      ['done', "The creator's 1 FACTORY bond released"],
      ['done', "The agent's 2 FACTORY bond released"],
    ])
    expect(pastSteps([event('Activated', { agentId: '7001', workerBond: String(2n * FACTORY) })], job)[0]?.sub).toBe('Reserved its 2 FACTORY bond from stake')
  })

  it('tells a refund, a slashed bond, a refunded top-up and a payout that could not be sent', () => {
    expect(titles([
      event('RewardSettled', { to: job.creator, outcome: 2, amount: '10000000' }),
      event('RewardSettled', { to: '0x3', outcome: 1, amount: '0' }),
      event('TopUpRefunded', { contributor: job.creator, amount: '2000000' }),
      event('BondSlashed', { side: 1, account: '0x3', amount: String(FACTORY) }),
      event('PayoutDeferred', { refundedToHolding: true }),
      event('PayoutOwed', { to: '0x3', token: MUSD, amount: '9500000' }),
    ])).toEqual([
      ['done', '10 mUSD returned to the creator'],
      ['done', '2 mUSD top-up refunded to its contributor'],
      ['fail', "The agent's 1 FACTORY bond slashed"],
      ['warn', 'Payout held: the transfer could not go through'],
      ['warn', '9.5 mUSD owed: the transfer failed'],
    ])
  })
})
