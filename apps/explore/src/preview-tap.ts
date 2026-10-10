/**
 * What a press on a link that previews does. Touch and pen have no hover to show the card, so their first tap opens
 * it; a second tap, a mouse click or a key press follows the link.
 */
export const tapAction = (pointerType: string | null, open: boolean): 'preview' | 'follow' =>
  (pointerType === 'touch' || pointerType === 'pen') && !open ? 'preview' : 'follow'
