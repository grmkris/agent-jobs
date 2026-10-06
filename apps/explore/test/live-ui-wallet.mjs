import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, decodeAbiParameters, decodeFunctionData, hexToString, http, keccak256, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';

const stringify = (v) => JSON.stringify(v, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2);
const digest = (v) => createHash('sha256').update(stringify(v)).digest('hex');
const lower = (v) => String(v).toLowerCase();
const refuse = (text) => { throw Object.assign(new Error(text), { code: 4100 }); };
const readMethods = new Set(['eth_call', 'eth_chainId', 'eth_blockNumber', 'eth_getCode', 'eth_getBalance',
  'eth_getBlockByNumber', 'eth_getTransactionCount', 'eth_getTransactionByHash', 'eth_getTransactionReceipt',
  'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory']);

const loadAbi = (name) => {
  const source = readFileSync(new URL(`../../../packages/sdk/src/abi/${name}.ts`, import.meta.url), 'utf8');
  return JSON.parse(source.slice(source.indexOf('['), source.lastIndexOf(']') + 1));
};
const batchAbi = parseAbi(['function execute(bytes32 mode, bytes executionCalldata)']);
const executionAbi = [{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'callData', type: 'bytes' }] }];

export function atomic(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const parent = file.slice(0, file.lastIndexOf('/'));
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  writeFileSync(temp, stringify(value), { mode: 0o600, flag: 'wx' });
  const fd = openSync(temp, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, file);
  const dir = openSync(parent, 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

function deploymentIdentity(config) {
  const d = config.deployment;
  const h = d.sidequest;
  assert.ok(h !== undefined && h !== null, 'LIVE-UI requires a promoted Sidequest deployment');
  return digest({
    chainId: config.chainId,
    block: d.block,
    sidequestBlock: h.block,
    core: lower(d.core),
    main: d.main,
    sidequest: h,
    rewardTokens: d.rewardTokens.map(lower),
    delegation: { manager: lower(config.delegation.manager), delegator: lower(config.delegation.delegator) },
  });
}

function acquireLock(file) {
  try { return openSync(file, 'wx', 0o600); }
  catch (error) { throw new Error(`LIVE-UI state is already in use (${error.code === 'EEXIST' ? 'another run' : 'lock error'})`, { cause: error }); }
}

export function loadAccount(envPath) {
  const stat = lstatSync(envPath);
  assert.ok(!stat.isSymbolicLink() && stat.isFile(), 'env file must be a regular file');
  assert.equal(stat.mode & 0o777, 0o600, 'env file must be mode 600');
  const key = readFileSync(envPath, 'utf8').match(/^UI_TESTNET_PRIVATE_KEY=(0x[0-9a-fA-F]{64})$/m)?.[1];
  assert.ok(key, 'UI_TESTNET_PRIVATE_KEY is missing');
  return privateKeyToAccount(key);
}

export function liveWallet({ account, config, stateDir, enabled, onTransaction = () => {}, rpcUrl = monadTestnet.rpcUrls.default.http[0], clients }) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const dirStat = lstatSync(stateDir);
  assert.ok(dirStat.isDirectory() && !dirStat.isSymbolicLink() && (dirStat.mode & 0o077) === 0, 'state directory must be private and regular');
  const path = `${stateDir}/wallet.json`;
  const lockPath = `${stateDir}/wallet.lock`;
  const lockFd = acquireLock(lockPath);
  let closed = false;
  const close = () => { if (!closed) { closed = true; closeSync(lockFd); unlinkSync(lockPath); } };
  try {
    if (existsSync(path)) {
      const stat = lstatSync(path);
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'wallet journal must be a regular file');
      assert.equal(stat.mode & 0o777, 0o600, 'wallet journal must be mode 600');
    }
  } catch (error) { close(); throw error; }
  let journal;
  try {
    const identity = deploymentIdentity(config);
    journal = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { version: 2, address: account.address, deployment: identity, records: {}, signatures: {} };
    assert.equal(lower(journal.address), lower(account.address), 'journal belongs to a different wallet');
    assert.equal(journal.version, 2, 'wallet journal format is unsupported; inspect the existing state directory');
    assert.equal(journal.deployment, identity, 'wallet journal belongs to a different deployment; reconcile it before using new deployment state');
  } catch (error) { close(); throw error; }
  const save = () => atomic(path, journal);
  const reads = clients?.reads ?? createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
  const wallet = clients?.wallet ?? createWalletClient({ account, chain: monadTestnet, transport: http(rpcUrl) });
  const h = config.deployment.sidequest;
  const targets = new Set([account.address, config.deployment.main.holding, config.deployment.main.evaluator,
    config.deployment.core, h.factory, h.vault, config.delegation.manager, ...config.deployment.rewardTokens].map(lower));
  const delegate = config.delegation.delegator;
  const policy = new Map([
    [lower(h.vault), [loadAbi('stakeVault'), ['stakeWithPermit', 'requestUnstake', 'cancelUnstake', 'withdraw']]],
    [lower(config.deployment.main.holding), [loadAbi('sidequestHolding'), ['publish', 'topUp', 'cancel', 'settle', 'claimTopUpRefund', 'withdraw']]],
    [lower(config.deployment.main.evaluator), [loadAbi('sidequestEvaluator'), ['accept', 'reject', 'rejectAfterWindow', 'retryDeferred', 'completeAfterSilence']]],
    [lower(config.deployment.core), [loadAbi('core'), ['claimRefund']]],
    [lower(h.distributor), [loadAbi('epochDistributor'), ['claim']]],
    [lower(config.delegation.manager), [parseAbi(['function disableDelegation(bytes32 delegationHash)']), ['disableDelegation']]],
    ...[h.factory, ...config.deployment.rewardTokens].map((token) => [lower(token), [parseAbi(['function approve(address spender, uint256 amount)']), ['approve']]]),
  ]);
  const checkCall = (to, data, value) => {
    assert.equal(BigInt(value ?? 0), 0n, 'K6 sends no native value');
    const rule = policy.get(lower(to));
    assert.ok(rule, 'call is outside the K6 user policy');
    const decoded = decodeFunctionData({ abi: rule[0], data });
    assert.ok(rule[1].includes(decoded.functionName), 'admin/Safe or unrelated calls are refused');
    if (decoded.functionName === 'approve') {
      assert.ok([h.vault, config.deployment.main.holding].map(lower).includes(lower(decoded.args[0])), 'unexpected token approval spender');
    }
  };
  let row = 'read-only';
  let tail = Promise.resolve();
  const serial = (run) => { const next = tail.then(run); tail = next.catch(() => {}); return next; };
  const signing = () => {
    if (closed) refuse('Wallet is closed');
    if (!enabled) refuse('Read-only mode refuses signatures and transactions');
    if (row === 'read-only') refuse('Choose a K6 row before signing or sending');
  };
  const assertChain = async () => assert.equal(await reads.getChainId(), 10143, 'testnet only');
  const signed = async (kind, input, make) => {
    signing();
    await assertChain();
    const key = digest({ kind, input });
    if (journal.signatures[key] !== undefined) {
      assert.ok(journal.signatures[key].state === 'signed' && journal.signatures[key].value !== undefined, 'signature preparation was interrupted; inspect the journal before continuing');
      return journal.signatures[key].value;
    }
    journal.signatures[key] = { row, kind, state: 'prepared' }; save();
    const value = await make();
    journal.signatures[key] = { row, kind, state: 'signed', value }; save();
    return value;
  };
  const reconcile = async (record) => {
    assert.ok(record.hash && record.raw, 'Preparation interrupted before durable signed bytes; inspect the journal');
    let receipt;
    try { receipt = await reads.getTransactionReceipt({ hash: record.hash }); }
    catch (error) { if (error.name !== 'TransactionReceiptNotFoundError') throw error; }
    if (receipt !== undefined) {
      record.status = receipt.status;
      record.gasUsed = receipt.gasUsed.toString();
      record.effectiveGasPrice = receipt.effectiveGasPrice.toString();
      record.blockNumber = receipt.blockNumber.toString(); save();
      onTransaction({ row: record.row, hash: record.hash, status: record.status });
      return record.hash;
    }
    try {
      await reads.getTransaction({ hash: record.hash });
      record.status = 'pending'; save();
      return record.hash;
    } catch (error) { if (error.name !== 'TransactionNotFoundError') throw error; }
    // A consumed nonce without the original receipt is unknown, never permission to create another transaction.
    const nonce = await reads.getTransactionCount({ address: account.address, blockTag: 'pending' });
    if (nonce > record.nonce) refuse('Original nonce consumed without a receipt; reconcile before continuing');
    if (nonce !== record.nonce) refuse('Original transaction nonce is not ready');
    record.status = 'broadcasting'; save();
    const broadcast = await reads.sendRawTransaction({ serializedTransaction: record.raw });
    assert.equal(lower(broadcast), lower(record.hash), 'RPC returned another transaction hash');
    record.status = 'pending'; save();
    onTransaction({ row: record.row, hash: record.hash, status: record.status });
    return record.hash;
  };
  const send = async (tx) => {
    signing();
    await assertChain();
    assert.equal(lower(tx.from ?? account.address), lower(account.address), 'another sender');
    assert.equal(Number(BigInt(tx.chainId ?? 10143)), 10143, 'another chain');
    assert.ok(targets.has(lower(tx.to)) || lower(tx.to) === lower(h.distributor), 'unexpected target');
    assert.equal(BigInt(tx.value ?? 0), 0n, 'K6 sends no native value');
    const input = { to: lower(tx.to), data: tx.data ?? '0x', value: '0' };
    if (input.to === lower(account.address)) {
      const current = await reads.getCode({ address: account.address });
      assert.equal(lower(current), `0xef0100${delegate.slice(2).toLowerCase()}`, 'self call requires the configured DeleGator');
      const decoded = decodeFunctionData({ abi: batchAbi, data: input.data });
      assert.equal(decoded.args[0], `0x01${'00'.repeat(31)}`, 'only atomic K6 batches are allowed');
      const [calls] = decodeAbiParameters(executionAbi, decoded.args[1]);
      assert.ok(calls.length > 0 && calls.length <= 4, 'unexpected batch size');
      calls.forEach((call) => checkCall(call.target, call.callData, call.value));
    } else checkCall(input.to, input.data, 0n);
    // One calldata intent per row/target/method. If the UI froze a different offer after a restart, refuse it.
    const key = `${row}:${input.to}:${input.data.slice(0, 10)}`;
    let record = journal.records[key];
    if (record !== undefined) {
      assert.equal(record.intent, digest(input), 'row already names different calls; resume the original operation');
      assert.ok(record.raw, 'preparation interrupted; inspect journal before continuing');
      return reconcile(record);
    }
    for (const other of Object.values(journal.records)) {
      if (!['success', 'reverted'].includes(other.status)) {
        await reconcile(other);
        if (!['success', 'reverted'].includes(other.status)) refuse('An earlier operation is still pending');
      }
    }
    record = { row, intent: digest(input), ...input, status: 'prepared' };
    journal.records[key] = record; save();
    const nonce = await reads.getTransactionCount({ address: account.address, blockTag: 'pending' });
    const prepared = await wallet.prepareTransactionRequest({ account, to: tx.to, data: input.data, value: 0n, nonce,
      ...(tx.gas === undefined ? {} : { gas: BigInt(tx.gas) }),
      ...(tx.gasPrice === undefined ? {} : { gasPrice: BigInt(tx.gasPrice) }),
      ...(tx.maxFeePerGas === undefined ? {} : { maxFeePerGas: BigInt(tx.maxFeePerGas) }),
      ...(tx.maxPriorityFeePerGas === undefined ? {} : { maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) }) });
    const maxCost = prepared.gas * (prepared.maxFeePerGas ?? prepared.gasPrice);
    const spent = Object.values(journal.records).reduce((sum, r) => sum + BigInt(r.gasUsed ?? 0) * BigInt(r.effectiveGasPrice ?? 0), 0n);
    assert.ok(spent + maxCost <= 1_500_000_000_000_000_000n, 'UI funding gas budget exceeded');
    assert.ok(await reads.getBalance({ address: account.address }) >= maxCost, 'UI wallet needs more gas');
    const raw = await wallet.signTransaction(prepared);
    Object.assign(record, { nonce, raw, hash: keccak256(raw), gas: prepared.gas.toString(), maxCost: maxCost.toString(), status: 'signed' });
    save(); // Signed bytes and intent are durable before the first possible economic effect.
    return reconcile(record);
  };
  const authorize = (input) => serial(async () => {
    signing();
    assert.equal(lower(input.contractAddress ?? input.address), lower(delegate), 'another delegation target');
    assert.equal(Number(input.chainId), 10143, 'another authorization chain');
    const nonce = Number(input.nonce);
    assert.equal(nonce, await reads.getTransactionCount({ address: account.address, blockTag: 'pending' }), 'authorization nonce changed');
    return signed('authorization', { address: delegate, chainId: 10143, nonce }, () =>
      wallet.signAuthorization({ account, contractAddress: delegate, chainId: 10143, nonce }));
  });
  const request = ({ method, params = [] }) => serial(async () => {
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [account.address];
    if (method === 'eth_chainId') return '0x279f';
    if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') {
      assert.equal(Number(BigInt(params[0].chainId)), 10143, 'testnet only'); return null;
    }
    if (method === 'wallet_getPermissions' || method === 'wallet_requestPermissions') return [];
    if (method === 'personal_sign') {
      signing();
      assert.equal(lower(params[1]), lower(account.address), 'another signing account');
      const message = params[0].startsWith('0x') ? hexToString(params[0]) : params[0];
      assert.ok(message.startsWith('dev.sidequest.exchange wants you to sign in') &&
        lower(message.split('\n')[1]) === lower(account.address) &&
        message.includes('Chain ID: 10143') &&
        /^URI: https:\/\/testnet\.sidequest\.xyz(?:\/|\s|$)/m.test(message), 'unexpected SIWE message');
      return signed('siwe', message, () => account.signMessage({ message }));
    }
    if (method === 'eth_signTypedData_v4') {
      signing();
      assert.equal(lower(params[0]), lower(account.address), 'another signing account');
      const supplied = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1];
      // Browser JSON commonly serializes uints as decimal strings. viem only includes
      // EIP-712 domain chainId when it is a number/bigint, so normalize the browser
      // payload before hashing or the signature silently omits chainId from the domain.
      const typed = structuredClone(supplied);
      if (typed.domain?.chainId !== undefined) typed.domain.chainId = Number(typed.domain.chainId);
      const fields = typed.types[typed.primaryType] ?? [];
      for (const field of fields) {
        if (/^u?int\d*$/.test(field.type) && typeof typed.message?.[field.name] === 'string') {
          typed.message[field.name] = BigInt(typed.message[field.name]);
        }
      }
      assert.equal(Number(typed.domain.chainId), 10143, 'another typed-data chain');
      assert.ok(targets.has(lower(typed.domain.verifyingContract)), 'unexpected typed-data contract');
      return signed('typed', typed, () => account.signTypedData(typed));
    }
    if (method === 'eth_sendTransaction') return send(params[0]);
    if (readMethods.has(method)) return reads.request({ method, params });
    refuse('Unsupported wallet method');
  });
  return { address: account.address, request, authorize, reads, setRow: (name) => { row = name; }, close,
    publicTransactions: () => Object.values(journal.records).filter((r) => r.hash).map((r) => ({
      row: r.row, hash: r.hash, to: r.to, status: r.status, nonce: r.nonce,
      gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice, blockNumber: r.blockNumber,
    })),
    signatures: () => Object.values(journal.signatures).map(({ value, ...rest }) => rest),
    wait: async () => {
      for (const r of Object.values(journal.records)) if (r.hash && !['success', 'reverted'].includes(r.status)) {
        await reads.waitForTransactionReceipt({ hash: r.hash, timeout: 120_000 }); await reconcile(r);
      }
    } };
}
