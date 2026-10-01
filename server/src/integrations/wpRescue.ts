import { randomBytes } from 'node:crypto';
import type { DirectAdminApi } from './types';
import { IntegrationError } from './http';

// „Trusa de prim-ajutor” pentru WordPress, aplicată prin DirectAdmin chiar și când site-ul e căzut:
// un must-use plugin generat din șablon fix (niciodată cod scris de AI), care poate
//  - dezactiva temporar pluginuri defecte (fără a le șterge sau redenumi),
//  - comuta temporar pe o temă sigură,
//  - captura erorile PHP într-un fișier privat,
//  - afișa o pagină de mentenanță vizitatorilor.
// Ștergerea fișierului anulează totul.

export interface RescueConfig {
  disabled_plugins: string[];
  theme: string | null;
  capture_errors: boolean;
  error_log: string;
  maintenance: boolean;
  maintenance_message: string;
  updated_at: string;
}

export const RESCUE_FILENAME = 'dax-rescue.php';
const MARK_START = '/*DAX_CONFIG:';
const MARK_END = ':DAX_CONFIG*/';

export function defaultRescueConfig(): RescueConfig {
  return {
    disabled_plugins: [],
    theme: null,
    capture_errors: false,
    error_log: `dax-errors-${randomBytes(8).toString('hex')}.log`,
    maintenance: false,
    maintenance_message: 'Site-ul este în mentenanță pentru câteva minute. Revenim imediat!',
    updated_at: new Date().toISOString(),
  };
}

export function renderRescuePlugin(cfg: RescueConfig): string {
  const encoded = Buffer.from(JSON.stringify(cfg), 'utf8').toString('base64');
  return `<?php
/**
 * Plugin Name: DAX Rescue (generat automat)
 * Description: Măsuri temporare aplicate de agentul DAX pentru a repune site-ul pe picioare. Șterge acest fișier pentru a anula toate măsurile.
 * Version: 1.0
 */
if (!defined('ABSPATH')) { exit; }

${MARK_START}${encoded}${MARK_END}
$dax_rescue = json_decode(base64_decode('${encoded}'), true);
if (!is_array($dax_rescue)) { return; }

// 1. Capturarea erorilor PHP într-un fișier privat (nume aleator)
if (!empty($dax_rescue['capture_errors'])) {
    $dax_log = WP_CONTENT_DIR . '/' . basename((string) $dax_rescue['error_log']);
    @ini_set('log_errors', '1');
    @ini_set('display_errors', '0');
    @ini_set('error_log', $dax_log);
    error_reporting(E_ALL & ~E_DEPRECATED & ~E_NOTICE);
    register_shutdown_function(function () use ($dax_log) {
        $e = error_get_last();
        if ($e && in_array($e['type'], array(E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR, E_RECOVERABLE_ERROR), true)) {
            $uri = isset($_SERVER['REQUEST_URI']) ? substr((string) $_SERVER['REQUEST_URI'], 0, 200) : '';
            @error_log('[DAX-FATAL] ' . $e['message'] . ' in ' . $e['file'] . ':' . $e['line'] . ' URI=' . $uri . "\\n", 3, $dax_log);
        }
    });
}

// 2. Dezactivarea temporară a pluginurilor defecte (fără a le modifica fișierele)
if (!empty($dax_rescue['disabled_plugins']) && is_array($dax_rescue['disabled_plugins'])) {
    $dax_filter = function ($plugins) use ($dax_rescue) {
        if (!is_array($plugins)) { return $plugins; }
        $blocked = $dax_rescue['disabled_plugins'];
        $is_assoc = array_keys($plugins) !== range(0, count($plugins) - 1);
        $out = array();
        foreach ($plugins as $k => $v) {
            $file = $is_assoc ? $k : $v;
            $skip = false;
            foreach ($blocked as $b) {
                $b = (string) $b;
                if ($file === $b || strpos($file, rtrim($b, '/') . '/') === 0 || $file === $b . '.php') { $skip = true; break; }
            }
            if (!$skip) { $out[$k] = $v; }
        }
        return $is_assoc ? $out : array_values($out);
    };
    add_filter('option_active_plugins', $dax_filter, 1);
    add_filter('site_option_active_sitewide_plugins', $dax_filter, 1);
}

// 3. Temă de siguranță
if (!empty($dax_rescue['theme'])) {
    $dax_theme = basename((string) $dax_rescue['theme']);
    if (is_dir(WP_CONTENT_DIR . '/themes/' . $dax_theme)) {
        $dax_theme_cb = function () use ($dax_theme) { return $dax_theme; };
        add_filter('pre_option_template', $dax_theme_cb, 1);
        add_filter('pre_option_stylesheet', $dax_theme_cb, 1);
    }
}

// 4. Pagină de mentenanță pentru vizitatori (administratorii și wp-admin funcționează în continuare)
if (!empty($dax_rescue['maintenance'])) {
    $dax_uri = isset($_SERVER['REQUEST_URI']) ? rawurldecode((string) $_SERVER['REQUEST_URI']) : '';
    $dax_is_admin_path = (strpos($dax_uri, '/wp-admin') !== false) || (strpos($dax_uri, 'wp-login.php') !== false) || (strpos($dax_uri, '/wp-json/dax/') !== false) || (strpos($dax_uri, 'rest_route=/dax/') !== false);
    $dax_logged = false;
    foreach (array_keys($_COOKIE) as $c) { if (strpos($c, 'wordpress_logged_in_') === 0) { $dax_logged = true; break; } }
    if (!$dax_is_admin_path && !$dax_logged && (!defined('WP_CLI') || !WP_CLI) && php_sapi_name() !== 'cli') {
        $dax_msg = htmlspecialchars((string) $dax_rescue['maintenance_message'], ENT_QUOTES, 'UTF-8');
        if (!headers_sent()) {
            header('HTTP/1.1 503 Service Unavailable');
            header('Retry-After: 600');
            header('Content-Type: text/html; charset=utf-8');
            header('Cache-Control: no-store');
        }
        echo '<!doctype html><html lang="ro"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mentenanță</title>'
            . '<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#f7f7f5;color:#1f2937}main{max-width:520px;padding:32px;text-align:center}h1{font-size:1.5rem}</style>'
            . '</head><body><main><h1>Revenim imediat</h1><p>' . $dax_msg . '</p></main></body></html>';
        exit;
    }
}
`;
}

export function parseRescuePlugin(content: string): RescueConfig | null {
  const start = content.indexOf(MARK_START);
  const end = content.indexOf(MARK_END);
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const json = Buffer.from(content.slice(start + MARK_START.length, end), 'base64').toString('utf8');
    return { ...defaultRescueConfig(), ...(JSON.parse(json) as Partial<RescueConfig>) };
  } catch {
    return null;
  }
}

export class WpRescue {
  constructor(
    private readonly da: DirectAdminApi,
    private readonly wpPath: string,
  ) {
    if (!wpPath.startsWith('/')) throw new IntegrationError('WordPress', 'calea WordPress din DirectAdmin trebuie să înceapă cu / (ex. /domains/datix.ro/public_html)');
  }

  private get muDir() {
    return `${this.wpPath.replace(/\/+$/, '')}/wp-content/mu-plugins`;
  }

  get pluginPath() {
    return `${this.muDir}/${RESCUE_FILENAME}`;
  }

  async status(): Promise<{ active: boolean; config: RescueConfig | null }> {
    try {
      const file = await this.da.readText(this.pluginPath, 64 * 1024);
      const cfg = parseRescuePlugin(file.content);
      return { active: !!cfg, config: cfg };
    } catch (err) {
      if (err instanceof IntegrationError && err.status === 404) return { active: false, config: null };
      throw err;
    }
  }

  async apply(patch: Partial<Omit<RescueConfig, 'error_log' | 'updated_at'>>): Promise<RescueConfig> {
    const current = (await this.status()).config ?? defaultRescueConfig();
    const next: RescueConfig = {
      ...current,
      ...patch,
      disabled_plugins: [...new Set((patch.disabled_plugins ?? current.disabled_plugins).map((p) => p.trim()).filter(Boolean))].slice(0, 50),
      updated_at: new Date().toISOString(),
    };
    for (const p of next.disabled_plugins) {
      if (!/^[A-Za-z0-9._\-/]+$/.test(p) || p.includes('..')) throw new IntegrationError('WordPress', `nume de plugin invalid: ${p}`);
    }
    if (next.theme && !/^[A-Za-z0-9._-]+$/.test(next.theme)) throw new IntegrationError('WordPress', `nume de temă invalid: ${next.theme}`);
    const nothingActive = !next.disabled_plugins.length && !next.theme && !next.capture_errors && !next.maintenance;
    if (nothingActive) {
      await this.remove();
      return next;
    }
    try {
      await this.da.listFiles(this.muDir, { limit: 1 });
    } catch (err) {
      if (err instanceof IntegrationError && err.status === 404) await this.da.mkdir(this.muDir);
      else throw err;
    }
    const res = await this.da.uploadFile(this.pluginPath, renderRescuePlugin(next), true);
    if (!res.verified) throw new IntegrationError('WordPress', 'fișierul de salvare nu a putut fi verificat după scriere.');
    return next;
  }

  async remove(): Promise<void> {
    if (await this.da.exists(this.pluginPath)) await this.da.trash([this.pluginPath]);
  }

  async readErrorLog(maxBytes = 64 * 1024): Promise<string> {
    const cfg = (await this.status()).config;
    if (!cfg) return '';
    try {
      const f = await this.da.readText(`${this.wpPath.replace(/\/+$/, '')}/wp-content/${cfg.error_log}`, maxBytes);
      return f.content;
    } catch (err) {
      if (err instanceof IntegrationError && err.status === 404) return '';
      throw err;
    }
  }
}
