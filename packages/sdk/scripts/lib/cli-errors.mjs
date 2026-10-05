/** Closed class list: provider-controlled names and messages never reach output. */
const classes = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError',
  'HttpRequestError', 'RpcRequestError', 'ContractFunctionExecutionError', 'TransactionReceiptNotFoundError'])

export function safeCliClass(error) {
  if (!(error instanceof Error)) return 'UnknownError'
  return classes.has(error.name) ? error.name : 'Error'
}

export function reportCliFailure(prefix, error, write = console.error) {
  write(`${prefix} [${safeCliClass(error)}]`)
}
