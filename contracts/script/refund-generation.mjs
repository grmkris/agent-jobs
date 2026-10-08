/** Refund identities isolate manifests, locks and saved signed bytes across redeploys. */
export function refundIdentity(generation = 'g1d', source = `pre-${generation}`) {
  if (!/^[a-z][a-z0-9-]{1,31}$/u.test(generation) || !/^[a-z][a-z0-9-]{1,31}$/u.test(source) || generation === source)
    throw new Error('refund: invalid generation/source')
  return { generation, source }
}

export function refundPaths(generation = 'g1d') {
  refundIdentity(generation)
  return { directory: `.${generation}-refunds`, manifest: `docs/evidence/testnet-${generation}/refund-manifest.json` }
}
