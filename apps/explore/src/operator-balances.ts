import { type Address, erc20Abi, isAddress } from "viem";
import { useBalance, useReadContracts } from "wagmi";
import { sidequest } from "./sidequest.ts";
import { chain, deployment } from "./wallet.ts";

/** These are wallet[0]'s spendable balances, never the managed agent's funds. */
export function useOperatorBalances(operator: Address | undefined, rewardToken: string = deployment.rewardTokens[0]!) {
  const validToken = isAddress(rewardToken);
  const tokens = useReadContracts({
    contracts: [
      { address: sidequest.factory, abi: erc20Abi, functionName: "balanceOf", args: [operator!], chainId: chain.id },
      { address: rewardToken as Address, abi: erc20Abi, functionName: "balanceOf", args: [operator!], chainId: chain.id },
    ],
    query: { enabled: operator !== undefined && validToken, refetchInterval: 15_000, retry: false },
  });
  const native = useBalance({ address: operator, chainId: chain.id, query: { enabled: operator !== undefined, refetchInterval: 15_000, retry: false } });
  const factoryRead = tokens.data?.[0];
  const rewardRead = tokens.data?.[1];
  return {
    factory: !tokens.isError && factoryRead?.status === "success" ? factoryRead.result : undefined,
    reward: !tokens.isError && rewardRead?.status === "success" ? rewardRead.result : undefined,
    native: native.isError ? undefined : native.data?.value,
  };
}
