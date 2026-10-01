<?php
/**
 * Protecții (XML-RPC, listarea utilizatorilor, editorul de fișiere) și modul mentenanță.
 */

if (!defined('ABSPATH')) {
    exit;
}

final class Datix_AI_Protect
{
    const HARDENING = 'datix_ai_connector_hardening';
    const MAINTENANCE = 'datix_ai_connector_maintenance';

    /** @return array */
    public static function hardening()
    {
        $h = get_option(self::HARDENING, array());
        $h = is_array($h) ? $h : array();
        return array(
            'disable_xmlrpc' => !empty($h['disable_xmlrpc']),
            'block_user_enum' => !empty($h['block_user_enum']),
            'disable_file_edit' => !empty($h['disable_file_edit']),
        );
    }

    public static function set_hardening(array $patch)
    {
        $h = self::hardening();
        foreach (array_keys($h) as $k) {
            if (array_key_exists($k, $patch) && $patch[$k] !== null) {
                $h[$k] = (bool) $patch[$k];
            }
        }
        update_option(self::HARDENING, $h, true);
        return $h;
    }

    /** @return array */
    public static function maintenance()
    {
        $m = get_option(self::MAINTENANCE, array());
        $m = is_array($m) ? $m : array();
        return array(
            'enabled' => !empty($m['enabled']),
            'message' => isset($m['message']) ? (string) $m['message'] : '',
            'since' => isset($m['since']) ? (int) $m['since'] : 0,
        );
    }

    public static function set_maintenance($enabled, $message = '')
    {
        $m = array(
            'enabled' => (bool) $enabled,
            'message' => sanitize_textarea_field((string) $message),
            'since' => $enabled ? time() : 0,
        );
        update_option(self::MAINTENANCE, $m, true);
        return $m;
    }

    public static function init()
    {
        $h = self::hardening();

        if ($h['disable_file_edit'] && !defined('DISALLOW_FILE_EDIT')) {
            define('DISALLOW_FILE_EDIT', true);
        }

        if ($h['disable_xmlrpc']) {
            if (defined('XMLRPC_REQUEST') && XMLRPC_REQUEST) {
                if (!headers_sent()) {
                    status_header(403);
                    header('Content-Type: text/plain; charset=utf-8');
                }
                echo 'XML-RPC este dezactivat pe acest site.';
                exit;
            }
            add_filter('xmlrpc_enabled', '__return_false');
            add_filter('xmlrpc_methods', '__return_empty_array');
            add_filter('wp_headers', array(__CLASS__, 'remove_pingback_header'));
            remove_action('wp_head', 'rsd_link');
        }

        if ($h['block_user_enum']) {
            add_action('template_redirect', array(__CLASS__, 'block_author_scan'), 1);
            add_filter('rest_endpoints', array(__CLASS__, 'hide_user_endpoints'));
            add_filter('wp_sitemaps_add_provider', array(__CLASS__, 'hide_user_sitemap'), 10, 2);
            add_filter('oembed_response_data', array(__CLASS__, 'hide_oembed_author'));
        }

        add_action('template_redirect', array(__CLASS__, 'maybe_maintenance'), 0);
    }

    public static function remove_pingback_header($headers)
    {
        unset($headers['X-Pingback']);
        return $headers;
    }

    /** Blochează ?author=N (dezvăluie numele de utilizator) pentru vizitatori. */
    public static function block_author_scan()
    {
        if (is_user_logged_in()) {
            return;
        }
        if (isset($_GET['author']) && preg_match('/\d/', (string) wp_unslash($_GET['author']))) {
            wp_safe_redirect(home_url('/'), 301);
            exit;
        }
    }

    public static function hide_user_endpoints($endpoints)
    {
        if (is_user_logged_in()) {
            return $endpoints;
        }
        foreach (array_keys($endpoints) as $route) {
            if (strpos($route, '/wp/v2/users') === 0) {
                unset($endpoints[$route]);
            }
        }
        return $endpoints;
    }

    public static function hide_user_sitemap($provider, $name)
    {
        return $name === 'users' ? false : $provider;
    }

    public static function hide_oembed_author($data)
    {
        unset($data['author_name'], $data['author_url']);
        return $data;
    }

    /** Pagina de mentenanță (HTTP 503) pentru vizitatori; cei autentificați văd site-ul normal. */
    public static function maybe_maintenance()
    {
        $m = self::maintenance();
        if (!$m['enabled']) {
            return;
        }
        if (is_user_logged_in() && current_user_can('edit_posts')) {
            return;
        }
        if (is_admin() || wp_doing_ajax() || wp_doing_cron() || (defined('REST_REQUEST') && REST_REQUEST)) {
            return;
        }
        nocache_headers();
        status_header(503);
        header('Retry-After: 900');
        header('Content-Type: text/html; charset=utf-8');
        $name = get_bloginfo('name');
        $message = $m['message'] !== '' ? $m['message'] : 'Facem câteva lucrări de întreținere. Revenim în câteva minute.';
        echo '<!doctype html><html lang="ro"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">';
        echo '<title>' . esc_html($name) . ' — mentenanță</title>';
        echo '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f9f9f7;color:#0b0b0b;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}main{max-width:32rem;padding:2rem;text-align:center}h1{font-size:1.5rem;margin:0 0 .5rem}p{color:#52514e;margin:0}@media (prefers-color-scheme:dark){body{background:#121211;color:#fff}p{color:#c3c2b7}}</style>';
        echo '</head><body><main><h1>' . esc_html($name) . '</h1><p>' . nl2br(esc_html($message)) . '</p></main></body></html>';
        exit;
    }
}
