<?php
/**
 * Audit de securitate: integritatea nucleului (sume de control oficiale wordpress.org),
 * fișiere PHP în uploads, fișiere PHP modificate recent, setări riscante, tipare de cod malițios.
 * Toate scanările au limite de timp și de număr de fișiere, ca să nu încarce hostingul.
 */

if (!defined('ABSPATH')) {
    exit;
}

final class Datix_AI_Audit
{
    const PHP_EXT = '/\.(php[0-9]?|phtml|phar|pht|phps|inc)$/i';

    /** Tipare de cod folosite aproape exclusiv de programe malițioase (puține alarme false). */
    private static function patterns()
    {
        return array(
            'eval_decode' => '/\b(eval|assert)\s*\(\s*(base64_decode|gzinflate|gzuncompress|gzdecode|str_rot13|strrev|rawurldecode|hex2bin)\s*\(/i',
            'eval_input' => '/\b(eval|assert)\s*\(\s*(stripslashes\s*\(\s*)?\$_(POST|GET|REQUEST|COOKIE|SERVER)\b/i',
            'exec_input' => '/\b(system|shell_exec|passthru|exec|popen|proc_open)\s*\(\s*(base64_decode\s*\(\s*)?\$_(POST|GET|REQUEST|COOKIE)\b/i',
            'dynamic_call_input' => '/\$_(POST|GET|REQUEST|COOKIE)\s*\[[^\]]{1,40}\]\s*\(\s*\$_(POST|GET|REQUEST|COOKIE)/i',
            'preg_replace_eval' => '/preg_replace\s*\(\s*([\'"])[^\'"]{0,200}\/[a-z]*e[a-z]*\1\s*,/i',
            'obfuscated_globals' => '/\$GLOBALS\s*\[\s*[\'"](\\\\x[0-9a-f]{2}){3,}/i',
            'remote_write' => '/file_put_contents\s*\([^;]{0,200}(\$_(POST|GET|REQUEST)|file_get_contents\s*\(\s*[\'"]https?:)/i',
            'known_shell' => '/(FilesMan|WSOsetcookie|b374k|c99shell|r57shell|IndoXploit|AlfaTeam|alfa-shell|0x5a455553|Tiny File Manager.{0,40}password)/i',
        );
    }

    // ---------------------------------------------------------------- utilitare de scanare

    private static function relative($path)
    {
        $root = wp_normalize_path(ABSPATH);
        $path = wp_normalize_path($path);
        return strpos($path, $root) === 0 ? substr($path, strlen($root)) : $path;
    }

    /**
     * Parcurge recursiv un director și apelează $fn pentru fiecare fișier PHP.
     * Se oprește la limita de timp ($deadline) sau la $max_files.
     */
    private static function walk($dir, $fn, $deadline, $max_files = 60000, $skip = array())
    {
        if (!is_dir($dir) || !is_readable($dir)) {
            return 0;
        }
        $count = 0;
        try {
            $it = new RecursiveIteratorIterator(
                new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS | FilesystemIterator::CURRENT_AS_FILEINFO),
                RecursiveIteratorIterator::LEAVES_ONLY,
                RecursiveIteratorIterator::CATCH_GET_CHILD
            );
            foreach ($it as $file) {
                if (++$count > $max_files || microtime(true) > $deadline) {
                    break;
                }
                if (!$file->isFile() || $file->isLink()) {
                    continue;
                }
                $path = wp_normalize_path($file->getPathname());
                $skipped = false;
                foreach ($skip as $prefix) {
                    if (strpos($path, $prefix) === 0) {
                        $skipped = true;
                        break;
                    }
                }
                if ($skipped || !preg_match(self::PHP_EXT, $path)) {
                    continue;
                }
                call_user_func($fn, $path, $file);
            }
        } catch (Exception $e) {
            // director inaccesibil: continuăm cu ce am putut citi
        }
        return $count;
    }

    // ---------------------------------------------------------------- verificări

    /** Sumele de control oficiale pentru versiunea instalată (păstrate o zi în cache). */
    private static function fetch_checksums($version, $locale)
    {
        $key = 'datix_ai_sums_' . md5($version . '|' . $locale);
        $cached = get_site_transient($key);
        if (is_array($cached) && !empty($cached)) {
            return $cached;
        }
        $url = 'https://api.wordpress.org/core/checksums/1.0/?' . http_build_query(array('version' => $version, 'locale' => $locale), '', '&');
        $res = wp_remote_get($url, array('timeout' => 20, 'user-agent' => 'DatixAIConnector/' . DATIX_AI_CONNECTOR_VERSION));
        if (is_wp_error($res) || (int) wp_remote_retrieve_response_code($res) !== 200) {
            return null;
        }
        $body = json_decode(trim((string) wp_remote_retrieve_body($res)), true);
        if (!is_array($body) || empty($body['checksums']) || !is_array($body['checksums'])) {
            return null;
        }
        set_site_transient($key, $body['checksums'], DAY_IN_SECONDS);
        return $body['checksums'];
    }

    /** Compară fișierele nucleului cu sumele de control oficiale. */
    public static function core_checksums()
    {
        global $wp_version, $wp_local_package;
        $locale = !empty($wp_local_package) ? $wp_local_package : 'en_US';
        $checksums = self::fetch_checksums($wp_version, $locale);
        if (!is_array($checksums) && $locale !== 'en_US') {
            $checksums = self::fetch_checksums($wp_version, 'en_US');
        }
        if (!is_array($checksums)) {
            return array('ok' => null, 'error' => 'Nu am putut descărca sumele de control de la wordpress.org.', 'modified' => array(), 'missing' => array(), 'unknown' => array());
        }
        $modified = array();
        $missing = array();
        foreach ($checksums as $file => $md5) {
            if (strpos($file, 'wp-content/') === 0) {
                continue;
            }
            $path = ABSPATH . $file;
            if (!file_exists($path)) {
                if (strpos($file, 'wp-admin/') === 0 || strpos($file, 'wp-includes/') === 0) {
                    $missing[] = $file;
                }
                continue;
            }
            if (md5_file($path) !== $md5) {
                $modified[] = $file;
            }
        }
        // fișiere PHP străine în nucleu (locul preferat al programelor malițioase)
        $unknown = array();
        $deadline = microtime(true) + 15;
        $root = wp_normalize_path(ABSPATH);
        foreach (array('wp-admin', 'wp-includes') as $dir) {
            self::walk($root . $dir, function ($path) use ($checksums, &$unknown) {
                $rel = Datix_AI_Audit::rel($path);
                if (!isset($checksums[$rel]) && count($unknown) < 200) {
                    $unknown[] = $rel;
                }
            }, $deadline);
        }
        foreach ((array) glob($root . '*.php') as $path) {
            $rel = basename($path);
            if (!isset($checksums[$rel]) && $rel !== 'wp-config.php' && count($unknown) < 200) {
                $unknown[] = $rel;
            }
        }
        return array(
            'ok' => empty($modified) && empty($unknown),
            'checked' => count($checksums),
            'modified' => array_slice($modified, 0, 200),
            'missing' => array_slice($missing, 0, 50),
            'unknown' => $unknown,
        );
    }

    /** Folosit din closure-uri (PHP 7.2 nu permite apelul metodelor private din closure statice). */
    public static function rel($path)
    {
        return self::relative($path);
    }

    /** Fișiere PHP în uploads — aproape mereu un semn de spargere. */
    public static function php_in_uploads()
    {
        $uploads = wp_upload_dir(null, false);
        $base = isset($uploads['basedir']) ? $uploads['basedir'] : '';
        $found = array();
        self::walk($base, function ($path, $file) use (&$found) {
            if (count($found) >= 200) {
                return;
            }
            $size = (int) $file->getSize();
            // index.php „Silence is golden” pus de unele pluginuri de securitate — inofensiv
            if ($size < 100 && strpos((string) @file_get_contents($path), 'Silence') !== false) {
                return;
            }
            $found[] = array('path' => Datix_AI_Audit::rel($path), 'size' => $size, 'modified' => gmdate('c', (int) $file->getMTime()));
        }, microtime(true) + 10);
        return $found;
    }

    /** Fișiere PHP modificate în ultimele $days zile (în afara nucleului). */
    public static function recently_modified_php($days = 7)
    {
        $since = time() - max(1, (int) $days) * DAY_IN_SECONDS;
        $found = array();
        $content = wp_normalize_path(WP_CONTENT_DIR);
        $deadline = microtime(true) + 15;
        $collect = function ($path, $file) use (&$found, $since) {
            $mtime = (int) $file->getMTime();
            if ($mtime >= $since) {
                $found[] = array('path' => Datix_AI_Audit::rel($path), 'modified' => gmdate('c', $mtime), 'ts' => $mtime);
            }
        };
        foreach (array('plugins', 'themes', 'mu-plugins', 'uploads') as $dir) {
            self::walk($content . '/' . $dir, $collect, $deadline);
        }
        foreach ((array) glob(wp_normalize_path(ABSPATH) . '*.php') as $path) {
            $mtime = (int) @filemtime($path);
            if ($mtime >= $since) {
                $found[] = array('path' => basename($path), 'modified' => gmdate('c', $mtime), 'ts' => $mtime);
            }
        }
        usort($found, function ($a, $b) {
            return $b['ts'] - $a['ts'];
        });
        $out = array();
        foreach (array_slice($found, 0, 100) as $f) {
            $out[] = array('path' => $f['path'], 'modified' => $f['modified']);
        }
        return $out;
    }

    /** Caută tipare de cod malițios în wp-content și în rădăcina site-ului. */
    public static function suspicious_code($time_budget = 25)
    {
        $patterns = self::patterns();
        $found = array();
        $deadline = microtime(true) + $time_budget;
        $self_dir = wp_normalize_path(DATIX_AI_CONNECTOR_DIR);
        $scan = function ($path, $file) use (&$found, $patterns) {
            if (count($found) >= 100 || $file->getSize() > 1572864) {
                return;
            }
            $code = @file_get_contents($path);
            if (!is_string($code) || $code === '') {
                return;
            }
            foreach ($patterns as $name => $re) {
                if (preg_match($re, $code, $m, PREG_OFFSET_CAPTURE)) {
                    $offset = (int) $m[0][1];
                    $line = substr_count(substr($code, 0, $offset), "\n") + 1;
                    $snippet = preg_replace('/\s+/', ' ', substr($code, max(0, $offset - 30), 140));
                    $found[] = array(
                        'path' => Datix_AI_Audit::rel($path),
                        'pattern' => $name,
                        'line' => $line,
                        'snippet' => wp_check_invalid_utf8((string) $snippet, true),
                    );
                    break;
                }
            }
        };
        $content = wp_normalize_path(WP_CONTENT_DIR);
        foreach (array('mu-plugins', 'uploads', 'plugins', 'themes') as $dir) {
            self::walk($content . '/' . $dir, $scan, $deadline, 60000, array($self_dir));
        }
        foreach ((array) glob(wp_normalize_path(ABSPATH) . '*.php') as $path) {
            if (basename($path) === 'wp-config.php') {
                continue;
            }
            $scan(wp_normalize_path($path), new SplFileInfo($path));
        }
        return array('matches' => $found, 'complete' => microtime(true) <= $deadline);
    }

    /** @return array */
    public static function admins()
    {
        $users = get_users(array('role' => 'administrator', 'orderby' => 'registered', 'order' => 'ASC', 'number' => 100));
        $logins = array();
        $out = array();
        foreach ($users as $u) {
            $logins[$u->user_login] = true;
            $out[] = self::admin_row($u);
        }
        if (is_multisite()) {
            foreach (get_super_admins() as $login) {
                if (isset($logins[$login])) {
                    continue;
                }
                $u = get_user_by('login', $login);
                if ($u) {
                    $out[] = self::admin_row($u);
                }
            }
        }
        return $out;
    }

    private static function admin_row($u)
    {
        $last = (int) get_user_meta($u->ID, 'datix_ai_last_login', true);
        return array(
            'id' => (int) $u->ID,
            'login' => $u->user_login,
            'email' => $u->user_email,
            'registered' => $u->user_registered,
            'last_login' => $last > 0 ? $last : null,
        );
    }

    public static function risky_settings()
    {
        global $wpdb;
        $h = Datix_AI_Protect::hardening();
        $config = file_exists(ABSPATH . 'wp-config.php') ? ABSPATH . 'wp-config.php' : dirname(ABSPATH) . '/wp-config.php';
        $perms = file_exists($config) ? (fileperms($config) & 0777) : null;
        $debug_log_public = defined('WP_DEBUG') && WP_DEBUG && defined('WP_DEBUG_LOG') && WP_DEBUG_LOG === true && file_exists(WP_CONTENT_DIR . '/debug.log');
        return array(
            'file_edit_enabled' => !(defined('DISALLOW_FILE_EDIT') && DISALLOW_FILE_EDIT),
            'xmlrpc_enabled' => !$h['disable_xmlrpc'],
            'user_enumeration' => !$h['block_user_enum'],
            'default_admin_username' => (bool) username_exists('admin'),
            'debug_display' => defined('WP_DEBUG') && WP_DEBUG && (!defined('WP_DEBUG_DISPLAY') || WP_DEBUG_DISPLAY),
            'debug_log_public' => $debug_log_public,
            'anyone_can_register_as_admin' => (bool) get_option('users_can_register') && get_option('default_role') === 'administrator',
            'search_engines_blocked' => !get_option('blog_public'),
            'default_table_prefix' => $wpdb->prefix === 'wp_',
            'wp_config_permissions' => $perms === null ? null : sprintf('%o', $perms),
            'wp_config_world_readable' => $perms !== null && ($perms & 0004) !== 0,
            'https_home' => strpos(home_url(), 'https://') === 0,
        );
    }

    /** Auditul complet cerut de agent. */
    public static function run($deep)
    {
        @set_time_limit($deep ? 120 : 60);
        $out = array(
            'core_checksums' => self::core_checksums(),
            'php_in_uploads' => self::php_in_uploads(),
            'recently_modified_php' => self::recently_modified_php(7),
            'admins' => self::admins(),
            'risky_settings' => self::risky_settings(),
        );
        if ($deep) {
            $code = self::suspicious_code(40);
            $out['suspicious_code'] = $code['matches'];
            $out['suspicious_code_complete'] = $code['complete'];
        } else {
            $out['suspicious_code'] = null;
            $out['note'] = 'Scanarea codului malițios rulează doar cu deep=true.';
        }
        return $out;
    }
}
