import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseAst } from 'vite';

function bind(node, names) {
    if (node?.type === 'Identifier') names.add(node.name);
    else if (node?.type === 'ObjectPattern') node.properties.forEach((p) => bind(p.value ?? p.argument, names));
    else if (node?.type === 'ArrayPattern') node.elements.forEach((p) => bind(p, names));
    else if (node?.type === 'RestElement') bind(node.argument, names);
    else if (node?.type === 'AssignmentPattern') bind(node.left, names);
}
function declared(node, names) {
    if (node === null || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration') { bind(node.id, names); return; }
    if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') return;
    if (node.type === 'VariableDeclarator') bind(node.id, names);
    if (node.type === 'CatchClause') bind(node.param, names);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach((descendant) => declared(descendant, names));
      else if (value !== null && typeof value === 'object') declared(value, names);
    }
}

// Modify only the hosted Privy boundary. All rendered pages, SDK, wagmi, transaction handling and board/indexer
// clients remain the deployed asset's code. Resolve identifiers from its AST because a staging release renames them.
export function patchPrivy(body) {
  const ast = parseAst(body);
  const functions = ast.body.filter((n) => n.type === 'FunctionDeclaration');
  const source = (n) => body.slice(n.start, n.end);
  const roots = functions.filter((n) => source(n).includes('appId:') && source(n).includes('embeddedWallets:') && source(n).includes('createOnLogin:'));
  if (roots.length === 0) return null;
  assert.equal(roots.length, 1, 'ambiguous hosted Privy root');
  const root = roots[0];
  const text = source(root);
  const jsx = text.match(/\(0,([\w$]+)\.jsxs\)/)?.[1];
  const bridgeName = text.match(/children:\[\(0,[\w$]+\.jsx\)\(([\w$]+),\{\}\),/)?.[1];
  const child = root.params[0]?.properties?.find((p) => p.key.name === 'children')?.value?.name;
  assert.ok(jsx && bridgeName && child, 'hosted Privy root shape changed');
  const bridge = functions.find((n) => n.id.name === bridgeName);
  assert.ok(bridge && source(bridge).includes('walletClientType') && source(bridge).includes('useEffect'), 'hosted wallet bridge shape changed');
  const privyHook = source(bridge).match(/\{authenticated:[\w$]+\}=([\w$]+)\(\)/)?.[1];
  const walletsHook = source(bridge).match(/\{wallets:[\w$]+\}=([\w$]+)\(\)/)?.[1];
  const delegator = functions.find((n) => source(n).includes('walletClientType') && source(n).includes('signAuthorization:') && source(n).includes('upgrade_account'));
  const authHook = delegator && source(delegator).match(/\{signAuthorization:[\w$]+\}=([\w$]+)\(\)/)?.[1];
  assert.ok(privyHook && walletsHook && authHook, 'hosted Privy hooks changed');
  const edits = [{ start: root.body.start, end: root.body.end,
    value: `{return(0,${jsx}.jsxs)(Symbol.for('react.fragment'),{children:[(0,${jsx}.jsx)(${bridgeName},{}),${child}]})}` }];
  const hooks = new Map([[privyHook, 'window.__livePrivy'], [walletsHook, 'window.__liveWallets'], [authHook, 'window.__liveAuthorization']]);
  const counts = new Map([...hooks.keys()].map((k) => [k, 0]));
  const walk = (node, shadowed) => {
    if (node === null || typeof node !== 'object') return;
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) {
      shadowed = new Set(shadowed);
      node.params.forEach((p) => bind(p, shadowed));
      bind(node.id, shadowed);
      declared(node.body, shadowed);
    }
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && hooks.has(node.callee.name) && !shadowed.has(node.callee.name)) {
      assert.equal(node.arguments.length, 0, 'unexpected Privy hook arguments');
      edits.push({ start: node.start, end: node.end, value: hooks.get(node.callee.name) });
      counts.set(node.callee.name, counts.get(node.callee.name) + 1);
    }
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach((descendant) => walk(descendant, shadowed));
      else if (v !== null && typeof v === 'object') walk(v, shadowed);
    }
  };
  for (const fn of functions) if (fn !== root) walk(fn, new Set());
  assert.ok(counts.get(privyHook) >= 4 && counts.get(privyHook) <= 6, 'unexpected Privy hook census');
  assert.equal(counts.get(walletsHook), 2, 'unexpected wallet hook census');
  assert.equal(counts.get(authHook), 1, 'unexpected authorization hook census');
  let patched = body;
  for (const e of edits.toSorted((a, b) => b.start - a.start)) patched = patched.slice(0, e.start) + e.value + patched.slice(e.end);
  parseAst(patched);
  return { body: patched, originalSha256: createHash('sha256').update(body).digest('hex'),
    patchedSha256: createHash('sha256').update(patched).digest('hex'), edits: edits.length };
}

const guardedBinding = (fn, origin) => async ({ frame }, args) => {
  assert.equal(new URL(frame.url()).origin, origin, 'wallet called by another origin');
  try { return await fn(args); }
  catch (error) { throw Object.assign(new Error(`LIVE-UI wallet request stopped (${error.name}); reconcile its journal before retrying`), { code: 4100 }); }
};

export async function injectWallet(context, { address, request, authorize, origin = 'https://dev.sidequest.exchange' }) {
  await context.exposeBinding('__liveWalletRequest', guardedBinding(request, origin));
  await context.exposeBinding('__liveWalletAuthorize', guardedBinding(authorize, origin));
  await context.addInitScript((me) => {
    const listeners = new Map();
    window.ethereum = { request: (args) => window.__liveWalletRequest(args),
      on: (name, fn) => listeners.set(name, fn), removeListener: (name) => listeners.delete(name) };
    const wallet = { address: me, walletClientType: 'privy',
      switchChain: async (id) => { if (Number(id) !== 10143) throw new Error('Testnet only'); },
      getEthereumProvider: async () => window.ethereum };
    window.__livePrivy = { ready: true, authenticated: true, login() {}, logout: async () => {} };
    window.__liveWallets = { wallets: [wallet] };
    window.__liveAuthorization = { signAuthorization: (args) => window.__liveWalletAuthorize(args) };
  }, address);
}
