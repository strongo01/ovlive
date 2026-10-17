export interface NdovPlanCancellationEnv {
  ASSETS: Fetcher;
  NDOV_FEEDS: DurableObjectNamespace;
}
export interface NdovPlanCancellationOptions {
  /** Include bounded per-identity NDOV diagnostics in the plan response. Disabled by default. */
  includeIdentityDiagnostics?: boolean;
}
export declare function applyNdovCancellationsToPlan<T extends Record<string, any>>(
  plan: T,
  env: NdovPlanCancellationEnv,
  options?: NdovPlanCancellationOptions,
): Promise<T>;
export declare function prepareNsTrainIdentities<T extends Record<string, any>>(
  plan: T,
  env: NdovPlanCancellationEnv,
): Promise<T>;
