<?php
/**
 * Rutele REST folosite de agent: /wp-json/dax/v1/*  (sau ?rest_route=/dax/v1/*).
 * Toate sunt POST și cer semnătura HMAC a agentului (DAX_Auth::permission).
 * Răspuns: { "ok": true, "data": ... }
 */

if (!defined('ABSPATH')) {
    exit;
}

final class DAX_API
{
    const NS = 'dax/v1';

    public static function init()
    {
        add_action('rest_api_init', array(__CLASS__, 'routes'));
        // unele pluginuri de securitate blochează REST pentru vizitatori; cererile semnate ale agentului trec
        add_filter('rest_authentication_errors', array(__CLASS__, 'allow_signed_requests'), 999);
    }

    public static function allow_signed_requests($result)
    {
        if (!is_wp_error($result) || empty($_SERVER['HTTP_X_DATIX_SIGNATURE'])) {
            return $result;
        }
        $uri = isset($_SERVER['REQUEST_URI']) ? rawurldecode((string) $_SERVER['REQUEST_URI']) : '';
        // permisiunea reală se verifică oricum în permission_callback (semnătura HMAC)
        return strpos($uri, '/' . self::NS . '/') !== false ? null : $result;
    }

    /** Ruta => metoda care o tratează. */
    private static function route_map()
    {
        return array(
            '/health' => 'health',
            '/plugins' => 'plugins',
            '/plugins/toggle' => 'toggle_plugin',
            '/updates/run' => 'run_updates',
            '/security/audit' => 'security_audit',
            '/security/events' => 'security_events',
            '/users/admins' => 'admins',
            '/maintenance' => 'maintenance',
            '/cache/purge' => 'purge_cache',
            '/debug-log' => 'debug_log',
            '/hardening' => 'hardening',
        );
    }

    public static function routes()
    {
        foreach (array_keys(self::route_map()) as $route) {
            register_rest_route(self::NS, $route, array(
                'methods' => 'POST',
                'callback' => array(__CLASS__, 'dispatch'),
                'permission_callback' => array('DAX_Auth', 'permission'),
            ));
        }
    }

    /** Rulează handler-ul și împachetează răspunsul; erorile devin mesaje clare pentru agent. */
    public static function dispatch($request)
    {
        $routes = self::route_map();
        $route = substr($request->get_route(), strlen('/' . self::NS));
        if (!isset($routes[$route])) {
            return new WP_Error('dax_unknown', 'Rută necunoscută.', array('status' => 404));
        }
        $params = $request->get_json_params();
        $params = is_array($params) ? $params : array();
        try {
            $data = call_user_func(array(__CLASS__, $routes[$route]), $params);
        } catch (Exception $e) {
            return new WP_Error('dax_error', $e->getMessage(), array('status' => 500));
        } catch (Error $e) {
            return new WP_Error('dax_error', 'Eroare PHP: ' . $e->getMessage(), array('status' => 500));
        }
        if (is_wp_error($data)) {
            $status = $data->get_error_data();
            return new WP_Error($data->get_error_code(), $data->get_error_message(), array('status' => is_array($status) && isset($status['status']) ? $status['status'] : 400));
        }
        $response = rest_ensure_response(array('ok' => true, 'data' => $data));
        $response->header('Cache-Control', 'no-store');
        return $response;
    }

    private static function load_admin_includes()
    {
        require_once ABSPATH . 'wp-admin/includes/plugin.php';
        require_once ABSPATH . 'wp-admin/includes/theme.php';
        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/misc.php';
        require_once ABSPATH . 'wp-admin/includes/update.php';
        if (!function_exists('wp_update_plugins')) {
            require_once ABSPATH . WPINC . '/update.php';
        }
    }

    /** Reîmprospătează informațiile despre actualizări cel mult o dată la 12 ore. */
    private static function maybe_refresh_updates($force = false)
    {
        $limit = $force ? 0 : 12 * HOUR_IN_SECONDS;
        $core = get_site_transient('update_core');
        if (!is_object($core) || empty($core->last_checked) || time() - (int) $core->last_checked > $limit) {
            wp_version_check(array(), $force);
        }
        $plugins = get_site_transient('update_plugins');
        if (!is_object($plugins) || empty($plugins->last_checked) || time() - (int) $plugins->last_checked > $limit) {
            if ($force) {
                delete_site_transient('update_plugins');
            }
            wp_update_plugins();
        }
        $themes = get_site_transient('update_themes');
        if (!is_object($themes) || empty($themes->last_checked) || time() - (int) $themes->last_checked > $limit) {
            if ($force) {
                delete_site_transient('update_themes');
            }
            wp_update_themes();
        }
    }

    private static function core_update_version()
    {
        global $wp_version;
        $core = get_site_transient('update_core');
        if (!is_object($core) || empty($core->updates)) {
            return null;
        }
        foreach ((array) $core->updates as $u) {
            if (isset($u->response, $u->current) && $u->response === 'upgrade' && version_compare($u->current, $wp_version, '>')) {
                return $u->current;
            }
        }
        return null;
    }

    private static function debug_log_path()
    {
        if (defined('WP_DEBUG_LOG') && is_string(WP_DEBUG_LOG) && WP_DEBUG_LOG !== '' && !in_array(strtolower(WP_DEBUG_LOG), array('1', 'true'), true)) {
            return WP_DEBUG_LOG;
        }
        return WP_CONTENT_DIR . '/debug.log';
    }

    // ---------------------------------------------------------------- /health

    public static function health($params)
    {
        global $wpdb, $wp_version;
        self::load_admin_includes();
        self::maybe_refresh_updates(!empty($params['refresh']));

        $theme = wp_get_theme();
        $update_themes = get_site_transient('update_themes');
        $update_plugins = get_site_transient('update_plugins');
        $stylesheet = $theme->get_stylesheet();
        $theme_update = null;
        if (is_object($update_themes) && isset($update_themes->response[$stylesheet]['new_version'])) {
            $theme_update = $update_themes->response[$stylesheet]['new_version'];
        }

        $all_plugins = get_plugins();
        $active = 0;
        foreach (array_keys($all_plugins) as $file) {
            if (is_plugin_active($file)) {
                $active++;
            }
        }

        $cron_overdue = 0;
        $crons = function_exists('_get_cron_array') ? _get_cron_array() : array();
        foreach ((array) $crons as $ts => $hooks) {
            if ((int) $ts < time() - 900) {
                $cron_overdue += count((array) $hooks);
            }
        }

        $log = self::debug_log_path();
        $h = DAX_Protect::hardening();
        $m = DAX_Protect::maintenance();

        $mu = array();
        foreach (get_mu_plugins() as $file => $data) {
            $mu[] = array('file' => $file, 'name' => $data['Name'], 'version' => $data['Version']);
        }
        $dropins = array_keys(get_dropins());

        return array(
            'wp_version' => $wp_version,
            'php_version' => PHP_VERSION,
            'db_version' => method_exists($wpdb, 'db_server_info') ? $wpdb->db_server_info() : $wpdb->db_version(),
            'site_url' => site_url(),
            'home_url' => home_url(),
            'multisite' => is_multisite(),
            'theme' => array(
                'name' => $theme->get('Name'),
                'version' => $theme->get('Version'),
                'stylesheet' => $stylesheet,
                'template' => $theme->get_template(),
                'update' => $theme_update,
            ),
            'plugins_total' => count($all_plugins),
            'plugins_active' => $active,
            'mu_plugins' => $mu,
            'dropins' => $dropins,
            'updates' => array(
                'core' => self::core_update_version(),
                'plugins' => is_object($update_plugins) && !empty($update_plugins->response) ? count((array) $update_plugins->response) : 0,
                'themes' => is_object($update_themes) && !empty($update_themes->response) ? count((array) $update_themes->response) : 0,
                'translations' => function_exists('wp_get_translation_updates') ? count(wp_get_translation_updates()) : 0,
            ),
            'flags' => array(
                'debug' => defined('WP_DEBUG') && WP_DEBUG,
                'debug_display' => defined('WP_DEBUG') && WP_DEBUG && (!defined('WP_DEBUG_DISPLAY') || WP_DEBUG_DISPLAY),
                'debug_log' => defined('WP_DEBUG_LOG') && WP_DEBUG_LOG ? true : false,
                'file_edit' => !(defined('DISALLOW_FILE_EDIT') && DISALLOW_FILE_EDIT),
                'file_mods' => !(defined('DISALLOW_FILE_MODS') && DISALLOW_FILE_MODS),
                'xmlrpc' => !$h['disable_xmlrpc'],
                'user_enum_blocked' => $h['block_user_enum'],
                'force_ssl_admin' => force_ssl_admin(),
                'https' => strpos(home_url(), 'https://') === 0,
                'blog_public' => (bool) get_option('blog_public'),
                'users_can_register' => (bool) get_option('users_can_register'),
                'default_role' => (string) get_option('default_role'),
                'auto_update_core' => defined('WP_AUTO_UPDATE_CORE') ? (is_bool(WP_AUTO_UPDATE_CORE) ? WP_AUTO_UPDATE_CORE : (string) WP_AUTO_UPDATE_CORE) : 'minor',
            ),
            'debug_log_bytes' => file_exists($log) ? (int) @filesize($log) : null,
            'cron' => array(
                'disabled' => defined('DISABLE_WP_CRON') && DISABLE_WP_CRON,
                'overdue' => $cron_overdue,
            ),
            'memory_limit' => defined('WP_MEMORY_LIMIT') ? WP_MEMORY_LIMIT : (string) ini_get('memory_limit'),
            'php_memory_limit' => (string) ini_get('memory_limit'),
            'max_execution_time' => (int) ini_get('max_execution_time'),
            'cache_plugins' => self::active_cache_plugins(),
            'object_cache' => wp_using_ext_object_cache(),
            'maintenance' => $m['enabled'] || file_exists(ABSPATH . '.maintenance'),
            'maintenance_message' => $m['message'],
            'server_software' => isset($_SERVER['SERVER_SOFTWARE']) ? substr((string) $_SERVER['SERVER_SOFTWARE'], 0, 80) : null,
            'timezone' => function_exists('wp_timezone_string') ? wp_timezone_string() : (string) get_option('timezone_string'),
            'connector_version' => DAX_CONNECTOR_VERSION,
        );
    }

    private static function cache_plugin_map()
    {
        return array(
            'litespeed-cache/litespeed-cache.php' => 'LiteSpeed Cache',
            'wp-rocket/wp-rocket.php' => 'WP Rocket',
            'w3-total-cache/w3-total-cache.php' => 'W3 Total Cache',
            'wp-super-cache/wp-cache.php' => 'WP Super Cache',
            'wp-fastest-cache/wpFastestCache.php' => 'WP Fastest Cache',
            'autoptimize/autoptimize.php' => 'Autoptimize',
            'sg-cachepress/sg-cachepress.php' => 'SiteGround Optimizer',
            'breeze/breeze.php' => 'Breeze',
            'cache-enabler/cache-enabler.php' => 'Cache Enabler',
            'hummingbird-performance/wp-hummingbird.php' => 'Hummingbird',
            'wp-optimize/wp-optimize.php' => 'WP-Optimize',
            'nitropack/main.php' => 'NitroPack',
            'cloudflare/cloudflare.php' => 'Cloudflare',
        );
    }

    private static function active_cache_plugins()
    {
        $out = array();
        foreach (self::cache_plugin_map() as $file => $name) {
            if (is_plugin_active($file)) {
                $out[] = $name;
            }
        }
        return $out;
    }

    // ---------------------------------------------------------------- pluginuri

    public static function plugins($params)
    {
        self::load_admin_includes();
        self::maybe_refresh_updates(false);
        $updates = get_site_transient('update_plugins');
        $auto = (array) get_site_option('auto_update_plugins', array());
        $out = array();
        foreach (get_plugins() as $file => $data) {
            $dir = dirname($file);
            $out[] = array(
                'file' => $file,
                'slug' => $dir === '.' ? basename($file, '.php') : $dir,
                'name' => $data['Name'],
                'version' => $data['Version'],
                'active' => is_plugin_active($file),
                'update' => (is_object($updates) && isset($updates->response[$file]->new_version)) ? $updates->response[$file]->new_version : null,
                'auto_update' => in_array($file, $auto, true),
                'author' => wp_strip_all_tags((string) $data['Author']),
            );
        }
        return $out;
    }

    public static function toggle_plugin($params)
    {
        self::load_admin_includes();
        $plugin = isset($params['plugin']) ? (string) $params['plugin'] : '';
        $active = !empty($params['active']);
        $all = get_plugins();
        if ($plugin === '' || !isset($all[$plugin])) {
            return new WP_Error('dax_no_plugin', 'Pluginul „' . $plugin . '” nu există. Folosește câmpul „file” din lista de pluginuri.', array('status' => 404));
        }
        if ($plugin === plugin_basename(DAX_CONNECTOR_FILE)) {
            return new WP_Error('dax_self', 'Pluginul DAX Connector nu se poate dezactiva prin el însuși.', array('status' => 400));
        }
        if ($active) {
            $r = activate_plugin($plugin);
            if (is_wp_error($r)) {
                return new WP_Error('dax_activate', 'Activarea a eșuat: ' . $r->get_error_message(), array('status' => 400));
            }
        } else {
            deactivate_plugins($plugin);
        }
        return array('plugin' => $plugin, 'active' => is_plugin_active($plugin));
    }

    // ---------------------------------------------------------------- actualizări

    public static function run_updates($params)
    {
        @set_time_limit(300);
        ignore_user_abort(true);
        self::load_admin_includes();
        require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
        if (!class_exists('Automatic_Upgrader_Skin')) {
            require_once ABSPATH . 'wp-admin/includes/class-automatic-upgrader-skin.php';
        }
        if (!WP_Filesystem()) {
            return new WP_Error('dax_fs', 'WordPress nu poate scrie direct fișierele (cere date FTP). Actualizează din wp-admin sau setează FS_METHOD „direct”.', array('status' => 400));
        }
        $type = isset($params['type']) ? (string) $params['type'] : '';
        $items = isset($params['items']) && is_array($params['items']) ? array_values(array_filter(array_map('strval', $params['items']))) : array();
        self::maybe_refresh_updates(true);
        $results = array();

        if ($type === 'plugin') {
            $updates = get_site_transient('update_plugins');
            $available = is_object($updates) && !empty($updates->response) ? array_keys((array) $updates->response) : array();
            $targets = $items ? array_values(array_intersect($items, $available)) : $available;
            foreach (array_diff($items, $targets) as $missing) {
                $results[] = array('item' => $missing, 'ok' => true, 'message' => 'Nu are actualizări disponibile.');
            }
            if ($targets) {
                $all = get_plugins();
                $was_active = array();
                foreach ($targets as $file) {
                    $was_active[$file] = is_plugin_active($file);
                }
                $skin = new Automatic_Upgrader_Skin();
                $upgrader = new Plugin_Upgrader($skin);
                $r = $upgrader->bulk_upgrade($targets);
                $fresh = get_plugins();
                foreach ($targets as $file) {
                    $res = is_array($r) && array_key_exists($file, $r) ? $r[$file] : false;
                    $ok = $res !== false && !is_wp_error($res) && $res !== null;
                    if ($ok && $was_active[$file] && !is_plugin_active($file)) {
                        activate_plugin($file, '', false, true);
                    }
                    $results[] = array(
                        'item' => $file,
                        'ok' => $ok,
                        'message' => $ok ? 'Actualizat.' : (is_wp_error($res) ? $res->get_error_message() : self::skin_errors($skin)),
                        'from' => isset($all[$file]['Version']) ? $all[$file]['Version'] : null,
                        'to' => isset($fresh[$file]['Version']) ? $fresh[$file]['Version'] : null,
                    );
                }
            }
        } elseif ($type === 'theme') {
            $updates = get_site_transient('update_themes');
            $available = is_object($updates) && !empty($updates->response) ? array_keys((array) $updates->response) : array();
            $targets = $items ? array_values(array_intersect($items, $available)) : $available;
            if ($targets) {
                $before = array();
                foreach ($targets as $slug) {
                    $before[$slug] = wp_get_theme($slug)->get('Version');
                }
                $skin = new Automatic_Upgrader_Skin();
                $upgrader = new Theme_Upgrader($skin);
                $r = $upgrader->bulk_upgrade($targets);
                foreach ($targets as $slug) {
                    $res = is_array($r) && array_key_exists($slug, $r) ? $r[$slug] : false;
                    $ok = $res !== false && !is_wp_error($res) && $res !== null;
                    wp_clean_themes_cache();
                    $results[] = array(
                        'item' => $slug,
                        'ok' => $ok,
                        'message' => $ok ? 'Actualizat.' : (is_wp_error($res) ? $res->get_error_message() : self::skin_errors($skin)),
                        'from' => $before[$slug],
                        'to' => wp_get_theme($slug)->get('Version'),
                    );
                }
            }
        } elseif ($type === 'core') {
            global $wp_version;
            $from = $wp_version;
            $updates = get_core_updates();
            $update = null;
            foreach ((array) $updates as $u) {
                if (isset($u->response) && $u->response === 'upgrade') {
                    $update = $u;
                    break;
                }
            }
            if (!$update) {
                $results[] = array('item' => 'core', 'ok' => true, 'message' => 'WordPress este deja la zi.', 'from' => $from, 'to' => $from);
            } else {
                $skin = new Automatic_Upgrader_Skin();
                $upgrader = new Core_Upgrader($skin);
                $r = $upgrader->upgrade($update);
                $ok = !is_wp_error($r) && $r !== false && $r !== null;
                $results[] = array(
                    'item' => 'core',
                    'ok' => $ok,
                    'message' => $ok ? 'WordPress a fost actualizat.' : (is_wp_error($r) ? $r->get_error_message() : self::skin_errors($skin)),
                    'from' => $from,
                    'to' => $ok ? (is_string($r) ? $r : $update->current) : $from,
                );
            }
        } elseif ($type === 'translations') {
            $skin = new Automatic_Upgrader_Skin();
            $upgrader = new Language_Pack_Upgrader($skin);
            $r = $upgrader->bulk_upgrade(array(), array('clear_update_cache' => true));
            $ok = !is_wp_error($r) && $r !== false;
            $results[] = array('item' => 'translations', 'ok' => $ok, 'message' => $ok ? 'Traducerile au fost actualizate.' : (is_wp_error($r) ? $r->get_error_message() : self::skin_errors($skin)));
        } else {
            return new WP_Error('dax_type', 'Tip necunoscut: folosește plugin, theme, core sau translations.', array('status' => 400));
        }

        if (!$results) {
            $results[] = array('item' => $type, 'ok' => true, 'message' => 'Nimic de actualizat.');
        }
        DAX_Events::log('updates_run', 'DAX', array('type' => $type, 'results' => $results));
        return array('results' => $results);
    }

    private static function skin_errors($skin)
    {
        $messages = method_exists($skin, 'get_upgrade_messages') ? $skin->get_upgrade_messages() : array();
        $messages = array_map('wp_strip_all_tags', (array) $messages);
        return $messages ? implode(' ', array_slice($messages, -3)) : 'Actualizarea a eșuat.';
    }

    // ---------------------------------------------------------------- securitate

    public static function security_audit($params)
    {
        return DAX_Audit::run(!empty($params['deep']));
    }

    public static function security_events($params)
    {
        $since = isset($params['since']) ? (int) $params['since'] : 0;
        $limit = isset($params['limit']) ? (int) $params['limit'] : 200;
        return DAX_Events::recent($since, $limit);
    }

    public static function admins($params)
    {
        return DAX_Audit::admins();
    }

    public static function hardening($params)
    {
        $patch = array();
        foreach (array('disable_xmlrpc', 'block_user_enum', 'disable_file_edit') as $k) {
            if (array_key_exists($k, $params) && $params[$k] !== null) {
                $patch[$k] = (bool) $params[$k];
            }
        }
        $state = DAX_Protect::set_hardening($patch);
        DAX_Events::log('hardening_changed', 'DAX', $state);
        $state['note'] = 'Se aplică de la următoarea încărcare a paginii.';
        return $state;
    }

    // ---------------------------------------------------------------- mentenanță, cache, jurnal

    public static function maintenance($params)
    {
        $enabled = !empty($params['enabled']);
        $message = isset($params['message']) ? (string) $params['message'] : '';
        $m = DAX_Protect::set_maintenance($enabled, $message);
        DAX_Events::log($enabled ? 'maintenance_on' : 'maintenance_off', 'DAX', $m['message']);
        return array('enabled' => $m['enabled'], 'message' => $m['message']);
    }

    public static function purge_cache($params)
    {
        $purged = array();
        if (has_action('litespeed_purge_all') || class_exists('LiteSpeed\\Purge')) {
            do_action('litespeed_purge_all');
            $purged[] = 'LiteSpeed Cache';
        }
        if (function_exists('rocket_clean_domain')) {
            rocket_clean_domain();
            if (function_exists('rocket_clean_minify')) {
                rocket_clean_minify();
            }
            $purged[] = 'WP Rocket';
        }
        if (function_exists('w3tc_flush_all')) {
            w3tc_flush_all();
            $purged[] = 'W3 Total Cache';
        }
        if (function_exists('wp_cache_clear_cache')) {
            wp_cache_clear_cache();
            $purged[] = 'WP Super Cache';
        }
        if (isset($GLOBALS['wp_fastest_cache']) && is_object($GLOBALS['wp_fastest_cache']) && method_exists($GLOBALS['wp_fastest_cache'], 'deleteCache')) {
            $GLOBALS['wp_fastest_cache']->deleteCache(true);
            $purged[] = 'WP Fastest Cache';
        }
        if (class_exists('autoptimizeCache') && method_exists('autoptimizeCache', 'clearall')) {
            call_user_func(array('autoptimizeCache', 'clearall'));
            $purged[] = 'Autoptimize';
        }
        if (function_exists('sg_cachepress_purge_cache')) {
            sg_cachepress_purge_cache();
            $purged[] = 'SiteGround Optimizer';
        }
        if (has_action('breeze_clear_all_cache')) {
            do_action('breeze_clear_all_cache');
            $purged[] = 'Breeze';
        }
        if (has_action('cache_enabler_clear_complete_cache')) {
            do_action('cache_enabler_clear_complete_cache');
            $purged[] = 'Cache Enabler';
        }
        if (has_action('wphb_clear_page_cache')) {
            do_action('wphb_clear_page_cache');
            $purged[] = 'Hummingbird';
        }
        if (class_exists('Elementor\\Plugin')) {
            $elementor = \Elementor\Plugin::$instance;
            if ($elementor && isset($elementor->files_manager) && method_exists($elementor->files_manager, 'clear_cache')) {
                $elementor->files_manager->clear_cache();
                $purged[] = 'Elementor (CSS)';
            }
        }
        wp_cache_flush();
        $purged[] = 'object-cache';
        DAX_Events::log('cache_purged', 'DAX', implode(', ', $purged));
        return array('purged' => $purged);
    }

    public static function debug_log($params)
    {
        $lines = isset($params['lines']) ? max(10, min(1000, (int) $params['lines'])) : 200;
        $path = self::debug_log_path();
        if (!file_exists($path) || !is_readable($path)) {
            return array('path' => null, 'bytes' => 0, 'content' => '');
        }
        $bytes = (int) filesize($path);
        $chunk = min($bytes, 256 * 1024);
        $fh = fopen($path, 'rb');
        if (!$fh) {
            return array('path' => DAX_Audit::rel($path), 'bytes' => $bytes, 'content' => '');
        }
        fseek($fh, -$chunk, SEEK_END);
        $data = (string) fread($fh, $chunk);
        fclose($fh);
        $all = preg_split('/\r?\n/', rtrim($data));
        if ($chunk < $bytes) {
            array_shift($all); // prima linie poate fi tăiată
        }
        $content = implode("\n", array_slice($all, -$lines));
        return array('path' => DAX_Audit::rel($path), 'bytes' => $bytes, 'content' => wp_check_invalid_utf8($content, true));
    }
}
