// Regional Webull OpenAPI hosts (from the official SDK's endpoints.json). Two
// surfaces per region: `api` (trading + account) and `quotesApi` (market data).
export type WebullRegion = 'us' | 'hk' | 'jp';

interface RegionHosts {
  api: string;
  quotesApi: string;
}

const HOSTS: Record<WebullRegion, RegionHosts> = {
  us: { api: 'api.webull.com', quotesApi: 'usquotes-api.webullfintech.com' },
  hk: { api: 'api.webull.hk', quotesApi: 'quotes-api.webull.hk' },
  jp: { api: 'api.webull.co.jp', quotesApi: 'quotes-api.webull.co.jp' },
};

export function normalizeRegion(region: string | undefined): WebullRegion {
  const r = (region || 'us').toLowerCase();
  return r === 'hk' || r === 'jp' ? r : 'us';
}

/** Host for a surface: market-data goes to quotesApi, everything else to api. */
export function webullHost(region: WebullRegion, surface: 'market' | 'trade'): string {
  return surface === 'market' ? HOSTS[region].quotesApi : HOSTS[region].api;
}
