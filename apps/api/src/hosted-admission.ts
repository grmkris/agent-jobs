import { admissionFailure, hostedTargetBoard, type HostedAdmission } from '@agent-jobs/board'

export function hostedCallFailure(policy: HostedAdmission, network: string, routeBoard: string, tool: string, args: Record<string, unknown>, sessionWallet: string | undefined): string | undefined {
  return admissionFailure(policy, network, hostedTargetBoard(routeBoard, tool, args), tool, sessionWallet)
}
