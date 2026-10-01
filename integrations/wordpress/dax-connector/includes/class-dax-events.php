<?php
/**
 * Jurnalul de securitate: autentificări, administratori noi, schimbări de rol, pluginuri, teme.
 * Evenimentele importante sunt trimise imediat agentului (cerere semnată, după ce pagina a fost livrată).
 */

if (!defined('ABSPATH')) {
    exit;
}

final class DAX_Events
{
    const DB_VERSION = '1';
    const DB_OPTION = 'dax_connector_db';
    const KNOWN_MODIFIED = 'dax_connector_known_modified';
    const CRON_HOOK = 'dax_connector_daily';
    const BURST_THRESHOLD = 20;
    const BURST_WINDOW = 600;
    const KEEP_DAYS = 90;

    /** Evenimente de trimis către agent la finalul cererii. */
    private static $queue = array();

    /** Utilizatori promovați la administrator în această cerere (user_id => date). */
    private static $pending_roles = array();

    public static function table()
    {
        global $wpdb;
        return $wpdb->prefix . 'dax_events';
    }

    public static function install()
    {
        global $wpdb;
        require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        $charset = $wpdb->get_charset_collate();
        $table = self::table();
        $sql = "CREATE TABLE {$table} (
  id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  at int(10) unsigned NOT NULL,
  type varchar(40) NOT NULL,
  user varchar(191) DEFAULT NULL,
  ip varchar(64) DEFAULT NULL,
  details text DEFAULT NULL,
  PRIMARY KEY  (id),
  KEY at (at),
  KEY type_at (type,at)
) {$charset};";
        dbDelta($sql);
        update_option(self::DB_OPTION, self::DB_VERSION, false);
        if (!wp_next_scheduled(self::CRON_HOOK)) {
            wp_schedule_event(time() + 600, 'daily', self::CRON_HOOK);
        }
    }

    public static function maybe_upgrade()
    {
        if (get_option(self::DB_OPTION) !== self::DB_VERSION) {
            self::install();
        }
    }

    public static function init()
    {
        add_action('wp_login', array(__CLASS__, 'on_login'), 10, 2);
        add_action('wp_login_failed', array(__CLASS__, 'on_login_failed'), 10, 1);
        add_action('user_register', array(__CLASS__, 'on_user_register'), 10, 1);
        add_action('set_user_role', array(__CLASS__, 'on_set_user_role'), 10, 3);
        add_action('add_user_role', array(__CLASS__, 'on_add_user_role'), 10, 2);
        add_action('delete_user', array(__CLASS__, 'on_delete_user'), 10, 1);
        add_action('after_password_reset', array(__CLASS__, 'on_password_reset'), 10, 1);
        add_action('activated_plugin', array(__CLASS__, 'on_plugin_activated'), 10, 1);
        add_action('deactivated_plugin', array(__CLASS__, 'on_plugin_deactivated'), 10, 1);
        add_action('upgrader_process_complete', array(__CLASS__, 'on_upgrader_complete'), 10, 2);
        add_action('switch_theme', array(__CLASS__, 'on_switch_theme'), 10, 1);
        add_action(self::CRON_HOOK, array(__CLASS__, 'daily'));
        add_action('shutdown', array(__CLASS__, 'flush'), 1000);
    }

    // ---------------------------------------------------------------- scriere

    private static function actor()
    {
        if (DAX_Auth::$agent_request) {
            return 'DAX';
        }
        $u = wp_get_current_user();
        return ($u && $u->exists()) ? $u->user_login : null;
    }

    public static function log($type, $user = null, $details = null)
    {
        global $wpdb;
        if (get_option(self::DB_OPTION) !== self::DB_VERSION) {
            return;
        }
        $wpdb->insert(
            self::table(),
            array(
                'at' => time(),
                'type' => substr((string) $type, 0, 40),
                'user' => $user === null ? null : substr((string) $user, 0, 191),
                'ip' => DAX_Auth::client_ip(),
                'details' => $details === null ? null : substr(is_string($details) ? $details : wp_json_encode($details), 0, 2000),
            ),
            array('%d', '%s', '%s', '%s', '%s')
        );
    }

    /** Pune un eveniment în coada de trimis către agent. */
    public static function push($event, array $data)
    {
        self::$queue[] = array('event' => $event, 'data' => $data);
    }

    /** Trimite evenimentele la final, după ce vizitatorul a primit pagina. */
    public static function flush()
    {
        foreach (self::$pending_roles as $data) {
            self::push('role_changed', $data);
        }
        self::$pending_roles = array();
        if (empty(self::$queue)) {
            return;
        }
        $url = DAX_Config::agent_url();
        if ($url === '' || !DAX_Config::is_configured()) {
            self::$queue = array();
            return;
        }
        if (function_exists('fastcgi_finish_request')) {
            fastcgi_finish_request();
        } elseif (function_exists('litespeed_finish_request')) {
            litespeed_finish_request();
        }
        $path = '/api/webhooks/wordpress';
        foreach (array_slice(self::$queue, 0, 10) as $item) {
            $body = wp_json_encode(array('event' => $item['event'], 'data' => $item['data'], 'sent_at' => time()));
            $headers = DAX_Auth::sign_headers('POST', $path, $body);
            $headers['Content-Type'] = 'application/json';
            wp_remote_post($url . $path, array(
                'timeout' => 5,
                'redirection' => 0,
                'headers' => $headers,
                'body' => $body,
                'user-agent' => 'DAXConnector/' . DAX_CONNECTOR_VERSION,
            ));
        }
        self::$queue = array();
    }

    // ---------------------------------------------------------------- evenimente WordPress

    public static function on_login($user_login, $user)
    {
        $roles = ($user instanceof WP_User) ? implode(',', (array) $user->roles) : '';
        self::log('login_success', $user_login, $roles);
        if ($user instanceof WP_User) {
            update_user_meta($user->ID, 'dax_last_login', time());
        }
    }

    public static function on_login_failed($username)
    {
        global $wpdb;
        self::log('login_failed', $username);
        $table = self::table();
        $since = time() - self::BURST_WINDOW;
        $count = (int) $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$table} WHERE type = 'login_failed' AND at > %d", $since));
        if ($count >= self::BURST_THRESHOLD && !get_transient('dax_burst_sent')) {
            set_transient('dax_burst_sent', 1, 30 * MINUTE_IN_SECONDS);
            $top = $wpdb->get_results($wpdb->prepare("SELECT ip, COUNT(*) n FROM {$table} WHERE type = 'login_failed' AND at > %d GROUP BY ip ORDER BY n DESC LIMIT 3", $since), ARRAY_A);
            self::push('login_failed_burst', array('count' => $count, 'minutes' => self::BURST_WINDOW / 60, 'top_ips' => $top));
        }
    }

    public static function on_user_register($user_id)
    {
        unset(self::$pending_roles[(int) $user_id]);
        $user = get_userdata($user_id);
        if (!$user) {
            return;
        }
        self::log('user_created', $user->user_login, array('roles' => $user->roles, 'by' => self::actor()));
        if (in_array('administrator', (array) $user->roles, true)) {
            self::log('admin_created', $user->user_login, array('email' => $user->user_email, 'by' => self::actor()));
            self::push('admin_created', array('user' => $user->user_login, 'email' => $user->user_email, 'by' => self::actor()));
        }
    }

    public static function on_set_user_role($user_id, $role, $old_roles)
    {
        $user = get_userdata($user_id);
        if (!$user) {
            return;
        }
        self::log('role_changed', $user->user_login, array('role' => $role, 'old' => $old_roles, 'by' => self::actor()));
        if ($role === 'administrator' && !in_array('administrator', (array) $old_roles, true)) {
            // la crearea unui utilizator, rolul se setează înainte de „user_register”: decidem la final
            self::$pending_roles[(int) $user_id] = array('user' => $user->user_login, 'role' => $role, 'by' => self::actor());
        }
    }

    public static function on_add_user_role($user_id, $role)
    {
        if ($role !== 'administrator') {
            return;
        }
        $user = get_userdata($user_id);
        if (!$user) {
            return;
        }
        self::log('role_added', $user->user_login, array('role' => $role, 'by' => self::actor()));
        self::$pending_roles[(int) $user_id] = array('user' => $user->user_login, 'role' => $role, 'by' => self::actor());
    }

    public static function on_delete_user($user_id)
    {
        $user = get_userdata($user_id);
        self::log('user_deleted', $user ? $user->user_login : ('#' . $user_id), array('by' => self::actor()));
    }

    public static function on_password_reset($user)
    {
        self::log('password_reset', ($user instanceof WP_User) ? $user->user_login : null);
    }

    public static function on_plugin_activated($plugin)
    {
        self::log('plugin_activated', self::actor(), $plugin);
    }

    public static function on_plugin_deactivated($plugin)
    {
        self::log('plugin_deactivated', self::actor(), $plugin);
    }

    public static function on_upgrader_complete($upgrader, $extra)
    {
        if (!is_array($extra) || empty($extra['type']) || empty($extra['action'])) {
            return;
        }
        if ($extra['action'] === 'install') {
            $name = '';
            if ($upgrader && isset($upgrader->new_plugin_data['Name'])) {
                $name = $upgrader->new_plugin_data['Name'];
            } elseif ($upgrader && isset($upgrader->new_theme_data['Name'])) {
                $name = $upgrader->new_theme_data['Name'];
            } elseif ($upgrader && method_exists($upgrader, 'plugin_info') && $extra['type'] === 'plugin') {
                $name = (string) $upgrader->plugin_info();
            }
            self::log($extra['type'] . '_installed', self::actor(), $name);
            if ($extra['type'] === 'plugin') {
                self::push('plugin_installed', array('plugin' => $name !== '' ? $name : 'necunoscut', 'by' => self::actor()));
            }
        } elseif ($extra['action'] === 'update') {
            $items = array();
            foreach (array('plugins', 'themes') as $k) {
                if (!empty($extra[$k]) && is_array($extra[$k])) {
                    $items = array_merge($items, $extra[$k]);
                }
            }
            self::log($extra['type'] . '_updated', self::actor(), $items ? implode(', ', $items) : null);
        }
    }

    public static function on_switch_theme($new_name)
    {
        self::log('theme_switched', self::actor(), $new_name);
        self::push('theme_switched', array('theme' => $new_name, 'by' => self::actor()));
    }

    // ---------------------------------------------------------------- citire

    /** @return array */
    public static function recent($since = 0, $limit = 200)
    {
        global $wpdb;
        if (get_option(self::DB_OPTION) !== self::DB_VERSION) {
            return array();
        }
        $table = self::table();
        $limit = max(1, min(500, (int) $limit));
        $rows = $wpdb->get_results($wpdb->prepare("SELECT id, at, type, user, ip, details FROM {$table} WHERE at >= %d ORDER BY id DESC LIMIT %d", (int) $since, $limit), ARRAY_A);
        $out = array();
        foreach ((array) $rows as $r) {
            $out[] = array(
                'id' => (int) $r['id'],
                'at' => (int) $r['at'],
                'type' => $r['type'],
                'user' => $r['user'],
                'ip' => $r['ip'],
                'details' => $r['details'],
            );
        }
        return $out;
    }

    // ---------------------------------------------------------------- zilnic

    /** Curăță jurnalul și verifică integritatea fișierelor nucleului WordPress. */
    public static function daily()
    {
        global $wpdb;
        $table = self::table();
        $wpdb->query($wpdb->prepare("DELETE FROM {$table} WHERE at < %d", time() - self::KEEP_DAYS * DAY_IN_SECONDS));
        $wpdb->query($wpdb->prepare("DELETE FROM {$table} WHERE type = 'login_failed' AND at < %d", time() - 30 * DAY_IN_SECONDS));

        $check = DAX_Audit::core_checksums();
        if (empty($check['ok']) && !empty($check['modified'])) {
            $known = get_option(self::KNOWN_MODIFIED, array());
            $known = is_array($known) ? $known : array();
            foreach (array_slice($check['modified'], 0, 20) as $file) {
                if (!in_array($file, $known, true)) {
                    self::log('file_changed', null, $file);
                    self::push('file_changed', array('file' => $file));
                    $known[] = $file;
                }
            }
            update_option(self::KNOWN_MODIFIED, array_slice($known, -500), false);
        } elseif (!empty($check['ok'])) {
            delete_option(self::KNOWN_MODIFIED);
        }
    }
}
