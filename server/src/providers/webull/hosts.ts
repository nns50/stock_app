// Regional Webull OpenAPI host. The current v2 API uses a single production
// gateway per region (api.webull.*); the older SDK's separate quotes host is
// retired. Overridable via WEBULL_API_HOST when needed (e.g. the UAT host).
export type WebullRegion = 'us' | 'hk' | 'jp';

const API_HOST: Record<WebullRegion, string> = {
  us: 'api.webull.com',
  hk: 'api.webull.hk',
  jp: 'api.webull.co.jp',
};

export function normalizeRegion(region: string | undefined): WebullRegion {
  const r = (region || 'us').toLowerCase();
  return r === 'hk' || r === 'jp' ? r : 'us';
}

export function webullHost(region: WebullRegion): string {
  return API_HOST[region];
}
