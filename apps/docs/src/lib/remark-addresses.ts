import { deployment, NotDeployedError, type Network } from '../../../../packages/sdk/src/deployment.ts'
import { visit } from 'unist-util-visit'
import type { Root, Table, TableRow } from 'mdast'
import type { MdxJsxFlowElement } from 'mdast-util-mdx'

const row = (left: string, right: string): TableRow => ({ type: 'tableRow', children: [{ type: 'tableCell', children: [{ type: 'text', value: left }] }, { type: 'tableCell', children: [{ type: 'inlineCode', value: right }] }] })

export function addressNode(network: Network): Table | Root['children'][number] {
  try {
    const d = deployment(network)
    const entries = [['Core', d.core], ['SIDE', d.sidequest?.factory ?? d.factory], ['Holding', d.stacks.main?.holding], ['Evaluator', d.stacks.main?.evaluator]]
    if (d.sidequest) entries.push(['Stake vault', d.sidequest.vault], ['Fee schedule', d.sidequest.feeSchedule], ['Mining distributor', d.sidequest.distributor], ['Owner Safe', d.sidequest.safe])
    return { type: 'table', align: [null, null], children: [row('Contract', `Address (${network})`), ...entries.filter((entry): entry is [string, string] => entry[1] !== undefined).map(([name, value]) => row(name, value))] }
  } catch (error) {
    if (!(error instanceof NotDeployedError)) throw error
    return { type: 'paragraph', children: [{ type: 'text', value: `Not deployed on ${network} yet.` }] }
  }
}
export function remarkAddresses() {
  return (tree: Root) => {
    const network = process.env.SIDEQUEST_NETWORK ?? 'monad-testnet'
    if (network !== 'monad-testnet' && network !== 'monad-mainnet') throw new Error(`Unsupported docs network: ${network}`)
    visit(tree, 'mdxJsxFlowElement', (node: MdxJsxFlowElement, index, parent) => {
      if (node.name === 'ContractAddresses' && parent && index !== undefined) parent.children[index] = addressNode(network)
    })
  }
}
