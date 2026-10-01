import type { WhmcsClient } from './whmcs';
import type { DirectAdminClient } from './directadmin';
import type { CloudflareClient } from './cloudflare';
import type { WordPressConnector } from './wordpress';
import type { httpCheck } from './net/httpCheck';
import type { checkTls } from './net/tls';
import type { dnsSnapshot, emailAuthCheck } from './net/dns';
import type { domainExpiry } from './net/domainExpiry';
import type { checkBlacklists } from './net/blacklist';
import type { securityScan } from './net/securityScan';
import type { fetchPublicPage } from './net/ssrf';
import type { runPageSpeed } from './pagespeed';
import type { checkComponent } from './wpvuln';

/** API-ul public al unei clase (fără câmpuri private) — permite implementări demo. */
export type PublicApi<T> = { [K in keyof T]: T[K] };

export type WhmcsApi = PublicApi<WhmcsClient>;
export type DirectAdminApi = PublicApi<DirectAdminClient>;
export type CloudflareApi = PublicApi<CloudflareClient>;
export type WordPressApi = PublicApi<WordPressConnector>;

export interface NetApi {
  http: typeof httpCheck;
  tls: typeof checkTls;
  dns: typeof dnsSnapshot;
  emailAuth: typeof emailAuthCheck;
  domainExpiry: typeof domainExpiry;
  blacklist: typeof checkBlacklists;
  securityScan: typeof securityScan;
  fetchPage: typeof fetchPublicPage;
  pagespeed: typeof runPageSpeed;
  wpVuln: typeof checkComponent;
}
