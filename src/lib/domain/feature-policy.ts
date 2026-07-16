export type PolicyInput = {
  planEnabled: boolean;
  tenantEnabled: boolean;
  teamEnabled?: boolean;
  userAllowed: boolean;
  providerCapable?: boolean;
  compliant: boolean;
  underUsageLimit: boolean;
};

export function canUseFeature(input: PolicyInput) {
  return input.planEnabled && input.tenantEnabled && (input.teamEnabled ?? true) && input.userAllowed && (input.providerCapable ?? true) && input.compliant && input.underUsageLimit;
}
