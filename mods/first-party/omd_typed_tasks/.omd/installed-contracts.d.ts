export type InstalledContractTypesVersion = 1;
export type InstalledHostRelease = '0.1.0';
export type InstalledModApi = '0.2.0-experimental.5';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface InstalledModServices {
  'omd.workflow@1.0.0': {
    checkpoint(input: Record<string, Json>): Record<string, Json>;
    delegate(input: Record<string, Json>): Record<string, Json>;
    status(input: null): Record<string, Json>;
  };
}
