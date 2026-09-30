export async function waitForTransactionReceipt(_config, { hash }) {
  const response = await fetch(`/__test/receipt?hash=${hash}`);
  if (!response.ok) throw new Error('Receipt RPC unavailable');
  return response.json();
}
