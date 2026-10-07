import { visit } from 'unist-util-visit'
import type { Root } from 'mdast'
import type { MdxJsxFlowElement, MdxJsxTextElement } from 'mdast-util-mdx'
import { docsOrigin } from './origin.ts'

const TOKEN = '{{SIDEQUEST_ORIGIN}}'
export function remarkOrigin() {
  return (tree: Root) => {
    const origin = docsOrigin()
    visit(tree, (node, index, parent) => {
      if (node.type === 'code' || node.type === 'inlineCode') node.value = node.value.replaceAll(TOKEN, origin)
      if (node.type === 'link' || node.type === 'definition') node.url = node.url.replaceAll(TOKEN, origin)
      if (
        (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') &&
        node.name === 'Origin' &&
        parent &&
        index !== undefined
      ) {
        const element = node as MdxJsxFlowElement | MdxJsxTextElement
        const path = element.attributes.find((a) => a.type === 'mdxJsxAttribute' && a.name === 'path')
        if (
          !path ||
          path.type !== 'mdxJsxAttribute' ||
          typeof path.value !== 'string' ||
          !path.value.startsWith('/') ||
          path.value.startsWith('//')
        )
          throw new Error('Origin requires a static root-relative path')
        const value = new URL(path.value, origin).href
        const inline = element.attributes.some((a) => a.type === 'mdxJsxAttribute' && a.name === 'link')
          ? { type: 'link' as const, url: value, children: [{ type: 'text' as const, value }] }
          : { type: 'inlineCode' as const, value }
        // On its own line the element is a block, so it becomes a paragraph; a bare inline node would glue its
        // neighbours together in the Markdown output.
        parent.children[index] =
          element.type === 'mdxJsxFlowElement' ? { type: 'paragraph', children: [inline] } : inline
      }
    })
  }
}
