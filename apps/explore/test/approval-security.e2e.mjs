import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, parseAbi } from 'viem';

// Actual TxSteps component, browser Web Locks and browser localStorage; wallet/chain are test doubles.
// No keys, signing, network provider or economic effect is involved.
const root = fileURLToPath(new URL('..', import.meta.url));
const wallet = '0x1111111111111111111111111111111111111111';
const agentWallet = '0x2222222222222222222222222222222222222222';
const config = JSON.parse(readFileSync(new URL('../../../contracts/config/monad-testnet.json', import.meta.url), 'utf8'));
const source = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { TxSteps } from '/src/components/TxSteps.tsx';
import { initializeTxJournal, txJournalKey } from '/src/components/txJournal.ts';
import { approvalSendError } from '/src/approval-operation.ts';
import { AgentFundingReview } from '/src/components/AgentFundingReview.tsx';
const txs = [{description:'Frozen top-up',chainId:10143,to:'${wallet}',data:'0x1234',value:'0'}];
window.__key = txJournalKey('approval:security', txs);
window.__expiresAt = Math.floor(Date.now()/1000)+600;
window.__done = false;
window.__walletAddress = '${wallet}';
if (new URLSearchParams(location.search).has('seed')) initializeTxJournal(localStorage, 'approval:security', txs);
const content = new URLSearchParams(location.search).has('funding') ? React.createElement(AgentFundingReview,{agent:{id:'agt_fixture',name:'Fixture agent',owner:'${wallet}',walletAddress:'${agentWallet}',kind:'privy',generation:0,status:'created',createdAt:0}}) : React.createElement(TxSteps,{taskId:'approval:security',txs,owner:'${wallet}',reportToBoard:false,retainRecord:true,allowBatch:false,allowSponsorship:false,requireJournal:true,sendGuard:()=>approvalSendError(window.__expiresAt),onDone:()=>{window.__done=true}});
const queryClient = new QueryClient({defaultOptions:{queries:{retry:false}}});
const rootRoute = createRootRoute({component:()=>React.createElement(QueryClientProvider,{client:queryClient},content)});
const route = createRoute({getParentRoute:()=>rootRoute,path:'/security',component:()=>null});
const router = createRouter({routeTree:rootRoute.addChildren([route])});
createRoot(document.getElementById('root')).render(React.createElement(RouterProvider,{router}));
`;
const modules = {
  'security-entry': source,
  'security-wallet': `export const useAuth=()=>({address:'${wallet}',signedIn:true});`,
  'security-privy': 'export const usePrivyBatch=()=>null;export const useAgentWallets=()=>({select:async(address)=>{window.__walletAddress=address;window.dispatchEvent(new Event("fixture-wallet-change"))}});',
  'security-wagmi': `
export const createConfig=()=>({}); export const http=()=>({}); export const custom=()=>({});
import {useSyncExternalStore} from 'react';const subscribe=fn=>{window.addEventListener('fixture-wallet-change',fn);return()=>window.removeEventListener('fixture-wallet-change',fn)};
export const useReadContract=()=>({data:false}); export const useAccount=()=>({address:useSyncExternalStore(subscribe,()=>window.__walletAddress),chainId:10143});
export const useSwitchChain=()=>({switchChainAsync:async()=>{}});
export const useSendTransaction=()=>({sendTransactionAsync:async(tx)=>{const r=await fetch('/__security/wallet',{method:'POST',body:JSON.stringify(tx,(_,v)=>typeof v==='bigint'?v.toString():v)});const body=await r.json();if(window.__walletLoseReply)throw new Error('Fixture lost wallet reply');return body.hash;}});
`,
  'security-actions': `
export const getTransactionCount=async()=>{await new Promise(r=>setTimeout(r,window.__readDelay??0));return 0};
export const getBlockNumber=async()=>{await new Promise(r=>setTimeout(r,window.__readDelay??0)); if(window.__expireDuringRead)window.__expiresAt=0;return 100n};
export const getBlock=async()=>({transactions:[]});
export const getTransaction=async(_config,{hash})=>{const transaction=await(await fetch('/__security/transaction?hash='+hash)).json();return {...transaction,value:BigInt(transaction.value)}};
export const waitForTransactionReceipt=async(_config,{hash})=>{const response=await fetch('/__security/receipt?hash='+hash);if(!response.ok)throw new Error('Receipt unavailable');return {status:'success'}};
`,
};
const server = await createServer({ root, configFile: false, envDir: false, define: { __AGENT_JOBS_NETWORK__: JSON.stringify('monad-testnet'), __PRIVY_APP_ID__: '""' }, plugins: [react(), {
  name: 'security-fixtures', enforce: 'pre',
  resolveId(id) {
    if (id === '/security-entry.tsx') return '\0security-entry';
    if (id === 'wagmi') return '\0security-wagmi';
    if (id === 'wagmi/actions') return '\0security-actions';
    if (id.endsWith('/Privy.tsx')) return '\0security-privy';
    if (id.endsWith('/Wallet.tsx')) return '\0security-wallet';
  },
  load(id) { return modules[id.slice(1)]; },
  transform(code, id) { if (id.endsWith('/src/components/AgentFundingReview.tsx')) return code.replace('const reads = createPublicClient({ chain, transport: http() })','const reads = window.__fundReads'); },
  configureServer(instance) { instance.middlewares.use((request, response, next) => {
    if (!request.url?.startsWith('/security?')) return next();
    response.setHeader('content-type', 'text/html');
    void instance.transformIndexHtml(request.url, '<html><body><div id="root"></div><script type="module" src="/security-entry.tsx"></script></body></html>').then(html=>response.end(html)).catch(next);
  }); },
}], server: { host: '127.0.0.1', port: 5217, strictPort: true } });
await server.listen();
const origin = 'http://127.0.0.1:5217';
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/home/kristjan/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' });
const errors = [];
const fixture = async () => {
  const context = await browser.newContext();
  // The component captures its read client at module evaluation, before the entry runs.
  await context.addInitScript(({operatorWallet}) => {
    window.__fundReads = {
      getBlockNumber:async()=>100n,
      getBalance:async({address})=>{if(window.__fundingUnavailable)throw new Error('Fixture RPC unavailable');return address.toLowerCase()===operatorWallet?10n**19n:0n},
      readContract:async({args,functionName})=>{if(window.__fundingUnavailable)throw new Error('Fixture RPC unavailable');return functionName==='balanceOf'&&args[0].toLowerCase()===operatorWallet?10n**24n:0n},
      getGasPrice:async()=>100n,estimateGas:async()=>21000n,
    };
  }, {operatorWallet:wallet});
  const state = { prompts: 0, receiptDown: false, transactionMismatch: false, delayWallet: 0, transactions: [], releaseReceipt: null, signalReceiptHeld: null };
  await context.route('**/__security/*', async route => {
    if (route.request().url().endsWith('/wallet')) {
      state.prompts++;
      state.transactions.push(route.request().postDataJSON());
      if (state.delayWallet) await new Promise(resolve => setTimeout(resolve, state.delayWallet));
      return route.fulfill({json:{hash:`0x${state.prompts.toString(16).padStart(64,'0')}`}});
    }
    if (route.request().url().includes('/transaction?')) {
      const tx = state.transactions[Number(BigInt(new URL(route.request().url()).searchParams.get('hash'))) - 1];
      return route.fulfill({json:{from:tx.account,to:tx.to,input:tx.data,value:state.transactionMismatch?'1':tx.value}});
    }
    if (route.request().frame().url().includes('lag') && new URL(route.request().url()).searchParams.get('hash') === `0x${'1'.padStart(64,'0')}`) {
      await new Promise(resolve => {state.releaseReceipt=resolve;state.signalReceiptHeld?.()});
    }
    return route.fulfill({status:state.receiptDown?503:200,json:{status:'success'}});
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  return {context,state};
};
try {
  // AF-001: expired at click, expired during RPC, and receipt retry after expiry.
  {
    const {context,state}=await fixture();const page=await context.newPage();
    await page.goto(`${origin}/security?seed`);await page.getByRole('button',{name:'Confirm in your wallet'}).waitFor();
    await page.evaluate(()=>{window.__expiresAt=0});
    await page.getByRole('button',{name:'Confirm in your wallet'}).click();
    await page.getByText(/approval expired/).waitFor();assert.equal(state.prompts,0);
    await page.reload();await page.evaluate(()=>{window.__expireDuringRead=true;window.__readDelay=100});
    await page.getByRole('button',{name:'Confirm in your wallet'}).click();
    await page.getByText(/approval expired/).waitFor();assert.equal(state.prompts,0);
    await page.reload();state.receiptDown=true;
    await page.getByRole('button',{name:'Confirm in your wallet'}).click();await page.getByRole('button',{name:'Try again'}).waitFor();
    assert.equal(state.prompts,1);state.receiptDown=false;await page.evaluate(()=>{window.__expiresAt=0});
    await page.getByRole('button',{name:'Try again'}).click();await page.waitForFunction(()=>window.__done);assert.equal(state.prompts,1);
    await context.close();
  }
  // Funding editing invalidates a stale tab; a mismatched receipt stays reconcilable without a resend.
  {
    const {context,state}=await fixture();const a=await context.newPage(),b=await context.newPage();
    await a.goto(`${origin}/security?funding`);await a.getByLabel('MON to send',{exact:true}).fill('0.5');
    await a.getByRole('button',{name:'Review funding'}).click();await a.getByRole('button',{name:'Confirm in your wallet'}).waitFor();
    await b.goto(`${origin}/security?funding`);await b.getByRole('button',{name:'Confirm in your wallet'}).waitFor();
    await a.getByRole('button',{name:'Edit an unsent review'}).click();await a.getByRole('button',{name:'Review funding'}).waitFor();
    await b.getByRole('button',{name:'Confirm in your wallet'}).click();await b.getByText(/journal is missing/).waitFor();assert.equal(state.prompts,0);
    await a.getByRole('button',{name:'Review funding'}).click();await a.getByRole('button',{name:'Confirm in your wallet'}).waitFor();
    state.transactionMismatch=true;
    await a.getByRole('button',{name:'Confirm in your wallet'}).click();await a.getByText(/receipt differs/).waitFor();assert.equal(state.prompts,1);
    state.transactionMismatch=false;await a.getByRole('button',{name:'Try again'}).click();await a.getByRole('status').getByText(/Funding confirmed/).waitFor();assert.equal(state.prompts,1);
    await context.close();
  }
  // Funding: freeze native/token values, refuse another signer, and resume the second transfer after reload.
  {
    const {context,state}=await fixture();const page=await context.newPage();
    await page.goto(`${origin}/security?funding`);
    await page.getByRole('button',{name:'Review funding'}).waitFor();
    await page.getByLabel('MON to send',{exact:true}).fill('0.5');await page.getByLabel('mUSD to send',{exact:true}).fill('2.1');
    await page.getByRole('button',{name:'Review funding'}).click();await page.getByRole('button',{name:'Confirm step 1 of 2'}).waitFor();
    assert.equal(state.prompts,0);
    await page.evaluate(address=>{window.__walletAddress=address;window.dispatchEvent(new Event('fixture-wallet-change'))},agentWallet);
    assert.equal(await page.getByRole('button',{name:'Confirm step 1 of 2'}).isDisabled(),true);
    await page.evaluate(address=>{window.__walletAddress=address;window.dispatchEvent(new Event('fixture-wallet-change'))},wallet);
    await page.getByRole('button',{name:'Confirm step 1 of 2'}).click();await page.getByRole('button',{name:'Confirm step 2 of 2'}).waitFor();
    assert.equal(state.prompts,1);assert.equal(state.transactions[0].value,'500000000000000000');assert.equal(state.transactions[0].to.toLowerCase(),agentWallet);
    await page.reload();await page.getByRole('button',{name:'Confirm step 2 of 2'}).waitFor();assert.equal(state.prompts,1);
    await page.getByRole('button',{name:'Confirm step 2 of 2'}).click();await page.getByRole('status').getByText(/Funding confirmed/).waitFor();
    assert.equal(state.prompts,2);assert.equal(state.transactions[1].to.toLowerCase(),config.deployment.rewardTokens[0].toLowerCase());
    const transfer=decodeFunctionData({abi:parseAbi(['function transfer(address,uint256)']),data:state.transactions[1].data});
    assert.equal(transfer.args[0].toLowerCase(),agentWallet);assert.equal(transfer.args[1],2100000n);
    await page.reload();await page.getByRole('status').getByText(/Funding confirmed/).waitFor();assert.equal(state.prompts,2);
    await context.close();
  }
  // AF-002: two stale, mounted tabs attempt the same send while the first wallet is open.
  {
    const {context,state}=await fixture();state.delayWallet=500;
    const a=await context.newPage(),b=await context.newPage();
    await a.goto(`${origin}/security?seed`);await a.getByRole('button',{name:'Confirm in your wallet'}).waitFor();
    await b.goto(`${origin}/security?resume`);await b.getByRole('button',{name:'Confirm in your wallet'}).waitFor();
    await Promise.all([a.getByRole('button',{name:'Confirm in your wallet'}).click(),b.getByRole('button',{name:'Confirm in your wallet'}).click()]);
    await a.waitForFunction(()=>window.__done);await b.waitForFunction(()=>window.__done);assert.equal(state.prompts,1);
    await context.close();
  }
  // AF-002: a delayed receipt reconciliation in another tab must not overwrite the next step's journal.
  {
    const {context,state}=await fixture();const a=await context.newPage(),b=await context.newPage();
    await a.goto(`${origin}/security?funding`);await a.getByLabel('MON to send',{exact:true}).fill('0.5');await a.getByLabel('mUSD to send',{exact:true}).fill('2.1');
    await a.getByRole('button',{name:'Review funding'}).click();await a.getByRole('button',{name:'Confirm step 1 of 2'}).click();await a.getByRole('button',{name:'Confirm step 2 of 2'}).waitFor();
    // Restore the durable state just after the first hash was saved, before its receipt was recorded.
    await a.evaluate(()=>{const key=Object.keys(localStorage).find(value=>value.startsWith('hireling.op-value:'));const record=JSON.parse(localStorage.getItem(key));record.recorded[0]=false;localStorage.setItem(key,JSON.stringify(record))});
    const held=new Promise(resolve=>{state.signalReceiptHeld=resolve});
    await b.goto(`${origin}/security?funding&lag`);await held;
    await a.getByRole('button',{name:'Confirm step 2 of 2'}).click();
    await new Promise(resolve=>setTimeout(resolve,500));
    state.releaseReceipt();await b.getByRole('button',{name:'Confirm step 2 of 2'}).waitFor();
    await b.getByRole('button',{name:'Confirm step 2 of 2'}).click();await b.getByRole('status').getByText(/Funding confirmed/).waitFor();assert.equal(state.prompts,2);
    await context.close();
  }
  // AF-004: quota failure before the wallet call, then missing/corrupt/unreadable state on restoration.
  {
    const {context,state}=await fixture();const page=await context.newPage();
    await page.goto(`${origin}/security?seed`);await page.evaluate(()=>{window.__walletLoseReply=true});
    await page.getByRole('button',{name:'Confirm in your wallet'}).click();await page.getByText(/returned an error without a transaction hash/).waitFor();
    const locks=await page.evaluate(()=>navigator.locks.query());assert.equal(locks.held.length,1,'AF-006: the wallet operation lock must remain held during ambiguous reconciliation');
    await page.getByText(/nothing left your account/).waitFor();assert.equal(state.prompts,1);
    await context.close();
  }
  // AF-004: quota failure before the wallet call, then missing/corrupt/unreadable state on restoration.
  {
    const {context,state}=await fixture();const page=await context.newPage();
    await page.goto(`${origin}/security?seed`);await page.getByRole('button',{name:'Confirm in your wallet'}).waitFor();
    await page.evaluate(()=>{Storage.prototype.setItem=function(){throw new Error('quota fixture')}});
    await page.getByRole('button',{name:'Confirm in your wallet'}).click();await page.getByText(/could not be saved/).waitFor();assert.equal(state.prompts,0);
    await page.reload();await page.evaluate(()=>{localStorage.removeItem(window.__key)});await page.goto(`${origin}/security?resume`);
    await page.getByText(/journal is missing/).waitFor();assert.equal(await page.getByRole('button',{name:'Confirm in your wallet'}).count(),0);
    await page.evaluate(()=>{localStorage.setItem(window.__key,'{')});await page.reload();await page.getByText(/journal is corrupt/).waitFor();
    await context.addInitScript(()=>{Storage.prototype.getItem=function(){throw new Error('unreadable fixture')}});
    await page.reload();await page.getByText(/journal is unreadable/).waitFor();assert.equal(state.prompts,0);
    await context.close();
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: AF-001, AF-002, AF-004 and reviewed native/token funding with reload; actual components, wallet and chain fixtures, zero live sends');
} catch (failure) {
  for (const context of browser.contexts()) for (const page of context.pages()) console.error('Fixture failure:', page.url(), await page.locator('body').innerText(), await page.evaluate(()=>Object.fromEntries(Object.entries(localStorage))));
  throw failure;
} finally {await browser.close();await server.close();}
