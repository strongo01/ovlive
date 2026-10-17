export interface NdovPlanCancellationEnv {
  ASSETS: Fetcher;
  NDOV_FEEDS: DurableObjectNamespace;
}
export declare function applyNdovCancellationsToPlan<T extends Record<string, any>>(
  plan: T,
  env: NdovPlanCancellationEnv,
): Promise<T>;
export declare function prepareNsTrainIdentities<T extends Record<string, any>>(
  plan: T,
  env: NdovPlanCancellationEnv,
): Promise<T>;
