import type { NetApi } from '../types';
import { httpCheck } from './httpCheck';
import { checkTls } from './tls';
import { dnsSnapshot, emailAuthCheck } from './dns';
import { domainExpiry } from './domainExpiry';
import { checkBlacklists } from './blacklist';
import { securityScan } from './securityScan';
import { fetchPublicPage } from './ssrf';
import { runPageSpeed } from '../pagespeed';
import { checkComponent } from '../wpvuln';

export const realNet: NetApi = {
  http: httpCheck,
  tls: checkTls,
  dns: dnsSnapshot,
  emailAuth: emailAuthCheck,
  domainExpiry,
  blacklist: checkBlacklists,
  securityScan,
  fetchPage: fetchPublicPage,
  pagespeed: runPageSpeed,
  wpVuln: checkComponent,
};
