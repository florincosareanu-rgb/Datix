<?php
/**
 * Mentenanță: integritatea fișierelor (nucleu + pluginuri, comparate cu wordpress.org),
 * reinstalarea unei componente, copii de siguranță înainte de actualizări și revenirea la ele.
 * Copiile se păstrează în afara directorului public când se poate (../dax-snapshots).
 */

if (!defined('ABSPATH')) {
    exit;
}

final class DAX_Maint
{
    /** Cât timp (secunde) are o cerere de verificare a pluginurilor, ca să nu încarce hostingul. */
    const TIME_BUDGET = 20;

    /** Limita copiei bazei de date (octeți necomprimați). */
    const DB_LIMIT = 314572800;

    private static function load_admin()
    {
        require_once ABSPATH . 'wp-admin/includes/plugin.php';
        require_once ABSPATH . 'wp-admin/includes/theme.php';
        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/misc.php';
        require_once ABSPATH . 'wp-admin/includes/update.php';
    }

    private static function load_upgrader()
    {
        self::load_admin();
        require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
        if (!class_exists('Automatic_Upgrader_Skin')) {
            require_once ABSPATH . 'wp-admin/includes/class-automatic-upgrader-skin.php';
        }
        if (!WP_Filesystem()) {
            return new WP_Error('dax_fs', 'WordPress nu poate scrie direct fișierele (cere date FTP). Setează FS_METHOD „direct”.', array('status' => 400));
        }
        return true;
    }

    private static function fetch_json($url)
    {
        $res = wp_remote_get($url, array('timeout' => 20, 'user-agent' => 'DAXConnector/' . DAX_CONNECTOR_VERSION));
        if (is_wp_error($res)) {
            return $res;
        }
        $code = (int) wp_remote_retrieve_response_code($res);
        if ($code === 404) {
            return null;
        }
        if ($code !== 200) {
            return new WP_Error('dax_http', 'HTTP ' . $code . ' de la ' . $url);
        }
        $data = json_decode(trim((string) wp_remote_retrieve_body($res)), true);
        return is_array($data) ? $data : new WP_Error('dax_json', 'Răspuns invalid de la ' . $url);
    }

    // ---------------------------------------------------------------- integritate

    public static function integrity($params)
    {
        @set_time_limit(120);
        $scope = isset($params['scope']) ? (string) $params['scope'] : 'core';
        if ($scope === 'core') {
            global $wp_version;
            $r = DAX_Audit::core_checksums();
            $r['scope'] = 'core';
            $r['version'] = $wp_version;
            return $r;
        }
        if ($scope === 'plugins') {
            return self::integrity_plugins(isset($params['offset']) ? (int) $params['offset'] : 0);
        }
        if ($scope === 'uploads') {
            return array('scope' => 'uploads', 'php_files' => DAX_Audit::php_in_uploads());
        }
        return new WP_Error('dax_scope', 'Zonă necunoscută: core, plugins sau uploads.', array('status' => 400));
    }

    /** Verifică pluginurile de pe wordpress.org, câte încap în bugetul de timp; „next” = de unde continuă. */
    private static function integrity_plugins($offset)
    {
        self::load_admin();
        $all = get_plugins();
        $files = array_keys($all);
        sort($files);
        $results = array();
        $started = microtime(true);
        $total = count($files);
        $i = max(0, (int) $offset);
        for (; $i < $total; $i++) {
            if (microtime(true) - $started > self::TIME_BUDGET) {
                break;
            }
            $results[] = self::check_plugin($files[$i], $all[$files[$i]]);
        }
        return array('scope' => 'plugins', 'total' => $total, 'results' => $results, 'next' => $i < $total ? $i : null);
    }

    private static function check_plugin($file, $data)
    {
        $dir = dirname($file);
        $slug = $dir === '.' ? basename($file, '.php') : $dir;
        $version = (string) $data['Version'];
        $entry = array(
            'file' => $file,
            'slug' => $slug,
            'name' => (string) $data['Name'],
            'version' => $version,
            'status' => 'ok',
            'checked' => 0,
            'modified' => array(),
            'added' => array(),
            'missing' => array(),
            'message' => null,
        );
        if ($dir === '.') {
            $entry['status'] = 'unverifiable';
            $entry['message'] = 'Plugin dintr-un singur fișier (fără sume de control publice).';
            return $entry;
        }
        if ($file === plugin_basename(DAX_CONNECTOR_FILE)) {
            $entry['status'] = 'unverifiable';
            $entry['message'] = 'Conectorul DAX e verificat separat de agent.';
            return $entry;
        }
        $sums = self::fetch_json('https://downloads.wordpress.org/plugin-checksums/' . rawurlencode($slug) . '/' . rawurlencode($version) . '.json');
        if (is_wp_error($sums)) {
            $entry['status'] = 'error';
            $entry['message'] = $sums->get_error_message();
            return $entry;
        }
        if (!is_array($sums) || empty($sums['files']) || !is_array($sums['files'])) {
            $entry['status'] = 'unverifiable';
            $entry['message'] = 'Nu există pe wordpress.org (plugin premium sau personalizat).';
            return $entry;
        }
        $base = wp_normalize_path(WP_PLUGIN_DIR . '/' . $dir) . '/';
        $listed = array();
        foreach ($sums['files'] as $rel => $info) {
            $rel = (string) $rel;
            $listed[$rel] = true;
            $path = $base . $rel;
            if (!file_exists($path)) {
                $entry['missing'][] = $rel;
                continue;
            }
            $entry['checked']++;
            $md5 = is_array($info) && isset($info['md5']) ? $info['md5'] : null;
            if ($md5 === null) {
                continue;
            }
            $expected = is_array($md5) ? $md5 : array($md5);
            if (!in_array(md5_file($path), $expected, true)) {
                $entry['modified'][] = $rel;
            }
        }
        // fișiere PHP care nu fac parte din plugin (cod adăugat)
        $added = array();
        DAX_Audit::walk_php($base, function ($path) use ($base, $listed, &$added) {
            $rel = substr($path, strlen($base));
            if (!isset($listed[$rel]) && count($added) < 50) {
                $added[] = $rel;
            }
        }, microtime(true) + 5, 20000);
        $entry['added'] = $added;
        if ($entry['modified'] || $entry['added']) {
            $entry['status'] = 'modified';
        }
        foreach (array('modified', 'missing') as $k) {
            $entry[$k] = array_slice($entry[$k], 0, 50);
        }
        return $entry;
    }

    // ---------------------------------------------------------------- reinstalare

    /** Reinstalează aceeași versiune (plugin de pe wordpress.org sau nucleul) peste fișierele modificate. */
    public static function reinstall($params)
    {
        @set_time_limit(300);
        ignore_user_abort(true);
        $ready = self::load_upgrader();
        if (is_wp_error($ready)) {
            return $ready;
        }
        $type = isset($params['type']) ? (string) $params['type'] : '';
        if ($type === 'core') {
            global $wp_version;
            $r = self::install_core_version($wp_version);
            DAX_Events::log('core_reinstalled', 'DAX', $r);
            return $r;
        }
        if ($type !== 'plugin') {
            return new WP_Error('dax_type', 'Tip necunoscut: plugin sau core.', array('status' => 400));
        }
        $file = isset($params['item']) ? (string) $params['item'] : '';
        $all = get_plugins();
        if ($file === '' || !isset($all[$file])) {
            return new WP_Error('dax_no_plugin', 'Pluginul „' . $file . '” nu există.', array('status' => 404));
        }
        $dir = dirname($file);
        if ($dir === '.') {
            return new WP_Error('dax_single', 'Pluginurile dintr-un singur fișier nu se pot reinstala automat.', array('status' => 400));
        }
        $version = (string) $all[$file]['Version'];
        $url = 'https://downloads.wordpress.org/plugin/' . rawurlencode($dir) . '.' . rawurlencode($version) . '.zip';
        $was_active = is_plugin_active($file);
        $skin = new Automatic_Upgrader_Skin();
        $upgrader = new Plugin_Upgrader($skin);
        $r = $upgrader->install($url, array('overwrite_package' => true));
        if ($was_active && !is_plugin_active($file)) {
            activate_plugin($file, '', false, true);
        }
        $ok = $r === true;
        $out = array('ok' => $ok, 'item' => $file, 'version' => $version, 'message' => $ok ? 'Reinstalat din sursa oficială.' : (is_wp_error($r) ? $r->get_error_message() : self::skin_errors($skin)));
        DAX_Events::log('plugin_reinstalled', 'DAX', $out);
        return $out;
    }

    /** Instalează o versiune anume a nucleului (reinstalare sau revenire după o actualizare stricată). */
    private static function install_core_version($version)
    {
        if (!preg_match('/^\d+\.\d+(\.\d+)?$/', (string) $version)) {
            return array('ok' => false, 'message' => 'Versiune invalidă: ' . $version);
        }
        $locale = get_locale();
        $candidates = array();
        if ($locale && $locale !== 'en_US') {
            $candidates[$locale] = 'https://downloads.wordpress.org/release/' . rawurlencode($locale) . '/wordpress-' . $version . '.zip';
        }
        $candidates['en_US'] = 'https://downloads.wordpress.org/release/wordpress-' . $version . '.zip';
        $last = 'Instalarea a eșuat.';
        foreach ($candidates as $loc => $url) {
            $update = (object) array(
                'response' => 'upgrade',
                'current' => $version,
                'version' => $version,
                'locale' => $loc,
                'download' => $url,
                'packages' => (object) array('full' => $url, 'no_content' => '', 'new_bundled' => '', 'partial' => false, 'rollback' => false),
                'php_version' => '7.2',
                'mysql_version' => '5.5',
                'new_bundled' => '',
                'partial_version' => '',
            );
            $skin = new Automatic_Upgrader_Skin();
            $upgrader = new Core_Upgrader($skin);
            $r = $upgrader->upgrade($update, array('pre_check_md5' => false));
            if (!is_wp_error($r) && $r) {
                return array('ok' => true, 'version' => $version, 'locale' => $loc, 'message' => 'Nucleul WordPress ' . $version . ' a fost instalat.');
            }
            $last = is_wp_error($r) ? $r->get_error_message() : self::skin_errors($skin);
        }
        return array('ok' => false, 'version' => $version, 'message' => $last);
    }

    private static function skin_errors($skin)
    {
        $messages = method_exists($skin, 'get_upgrade_messages') ? $skin->get_upgrade_messages() : array();
        $messages = array_map('wp_strip_all_tags', (array) $messages);
        return $messages ? implode(' ', array_slice($messages, -3)) : 'Operațiunea a eșuat.';
    }

    // ---------------------------------------------------------------- copii de siguranță

    private static function snapshot_root()
    {
        $outside = wp_normalize_path(dirname(rtrim(ABSPATH, '/\\'))) . '/dax-snapshots';
        if ((is_dir($outside) || @mkdir($outside, 0700)) && is_writable($outside)) {
            return $outside;
        }
        $inside = wp_normalize_path(WP_CONTENT_DIR) . '/dax-snapshots';
        if (!is_dir($inside)) {
            wp_mkdir_p($inside);
        }
        if (!file_exists($inside . '/.htaccess')) {
            @file_put_contents($inside . '/.htaccess', "Require all denied\nDeny from all\n");
        }
        if (!file_exists($inside . '/index.php')) {
            @file_put_contents($inside . '/index.php', "<?php\n// Silence is golden.\n");
        }
        return $inside;
    }

    private static function run_dir($params)
    {
        $run = isset($params['run']) ? (string) $params['run'] : '';
        if (!preg_match('/^[a-z0-9_-]{4,64}$/i', $run)) {
            return new WP_Error('dax_run', 'Identificator de rulare invalid.', array('status' => 400));
        }
        return self::snapshot_root() . '/' . $run;
    }

    /** Calea pe disc a unui plugin (director sau fișier unic) sau a unei teme. */
    private static function item_path($type, $item)
    {
        if (strpos($item, '..') !== false || $item === '') {
            return new WP_Error('dax_item', 'Element invalid.', array('status' => 400));
        }
        if ($type === 'plugin') {
            $all = get_plugins();
            if (!isset($all[$item])) {
                return new WP_Error('dax_no_plugin', 'Pluginul „' . $item . '” nu există.', array('status' => 404));
            }
            $dir = dirname($item);
            $path = wp_normalize_path(WP_PLUGIN_DIR . '/' . ($dir === '.' ? $item : $dir));
            return array('path' => $path, 'is_dir' => $dir !== '.', 'active' => is_plugin_active($item), 'version' => (string) $all[$item]['Version']);
        }
        if ($type === 'theme') {
            $theme = wp_get_theme($item);
            if (!$theme->exists()) {
                return new WP_Error('dax_no_theme', 'Tema „' . $item . '” nu există.', array('status' => 404));
            }
            return array('path' => wp_normalize_path($theme->get_stylesheet_directory()), 'is_dir' => true, 'active' => get_stylesheet() === $item, 'version' => (string) $theme->get('Version'));
        }
        return new WP_Error('dax_type', 'Tip necunoscut: plugin sau theme.', array('status' => 400));
    }

    private static function safe_name($item)
    {
        return preg_replace('/[^A-Za-z0-9._-]/', '_', $item);
    }

    private static function copy_tree($src, $dest)
    {
        $bytes = 0;
        if (is_file($src)) {
            wp_mkdir_p(dirname($dest));
            if (!@copy($src, $dest)) {
                throw new Exception('Nu pot copia ' . DAX_Audit::rel($src));
            }
            return (int) filesize($src);
        }
        wp_mkdir_p($dest);
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($src, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::SELF_FIRST);
        foreach ($it as $file) {
            $target = $dest . '/' . substr(wp_normalize_path($file->getPathname()), strlen(wp_normalize_path($src)) + 1);
            if ($file->isDir()) {
                wp_mkdir_p($target);
            } elseif ($file->isFile()) {
                if (!@copy($file->getPathname(), $target)) {
                    throw new Exception('Nu pot copia ' . DAX_Audit::rel($file->getPathname()));
                }
                $bytes += (int) $file->getSize();
            }
        }
        return $bytes;
    }

    private static function delete_tree($path)
    {
        if (is_link($path) || is_file($path)) {
            return @unlink($path);
        }
        if (!is_dir($path)) {
            return true;
        }
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($path, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($it as $file) {
            $file->isDir() && !$file->isLink() ? @rmdir($file->getPathname()) : @unlink($file->getPathname());
        }
        return @rmdir($path);
    }

    /** Copie a pluginurilor/temelor care urmează să fie actualizate (+ opțional baza de date). */
    public static function snapshot($params)
    {
        @set_time_limit(300);
        ignore_user_abort(true);
        self::load_admin();
        $root = self::run_dir($params);
        if (is_wp_error($root)) {
            return $root;
        }
        wp_mkdir_p($root);
        $items = isset($params['items']) && is_array($params['items']) ? $params['items'] : array();
        $manifest = array();
        $out = array();
        foreach ($items as $it) {
            $type = isset($it['type']) ? (string) $it['type'] : '';
            $item = isset($it['item']) ? (string) $it['item'] : '';
            $info = self::item_path($type, $item);
            if (is_wp_error($info)) {
                $out[] = array('type' => $type, 'item' => $item, 'ok' => false, 'message' => $info->get_error_message());
                continue;
            }
            $dest = $root . '/' . $type . '/' . self::safe_name($item);
            try {
                self::delete_tree($dest);
                $bytes = self::copy_tree($info['path'], $info['is_dir'] ? $dest : $dest . '/' . basename($info['path']));
                $manifest[$type . ':' . $item] = array('active' => $info['active'], 'version' => $info['version'], 'is_dir' => $info['is_dir']);
                $out[] = array('type' => $type, 'item' => $item, 'ok' => true, 'bytes' => $bytes, 'version' => $info['version']);
            } catch (Exception $e) {
                $out[] = array('type' => $type, 'item' => $item, 'ok' => false, 'message' => $e->getMessage());
            }
        }
        $db = null;
        if (!empty($params['db'])) {
            $db = self::export_db($root . '/database.sql.gz');
        }
        $previous = file_exists($root . '/manifest.json') ? json_decode((string) file_get_contents($root . '/manifest.json'), true) : array();
        $manifest = array_merge(is_array($previous) ? $previous : array(), $manifest);
        file_put_contents($root . '/manifest.json', wp_json_encode($manifest));
        DAX_Events::log('snapshot_created', 'DAX', array('items' => count($out), 'db' => $db ? $db['ok'] : null));
        return array('dir' => DAX_Audit::rel($root), 'items' => $out, 'db' => $db);
    }

    /** Revine la copia făcută înainte de actualizare. Versiunea stricată e păstrată deoparte. */
    public static function rollback($params)
    {
        @set_time_limit(300);
        ignore_user_abort(true);
        self::load_admin();
        $root = self::run_dir($params);
        if (is_wp_error($root)) {
            return $root;
        }
        if (!is_dir($root)) {
            return new WP_Error('dax_no_snapshot', 'Copia de siguranță pentru această rulare nu există.', array('status' => 404));
        }
        $manifest = json_decode((string) @file_get_contents($root . '/manifest.json'), true);
        $manifest = is_array($manifest) ? $manifest : array();
        $items = isset($params['items']) && is_array($params['items']) ? $params['items'] : array();
        $out = array();
        foreach ($items as $it) {
            $type = isset($it['type']) ? (string) $it['type'] : '';
            $item = isset($it['item']) ? (string) $it['item'] : '';
            $meta = isset($manifest[$type . ':' . $item]) ? $manifest[$type . ':' . $item] : null;
            if (!$meta || strpos($item, '..') !== false) {
                $out[] = array('type' => $type, 'item' => $item, 'ok' => false, 'message' => 'Nu există copie pentru acest element.');
                continue;
            }
            $snap = $root . '/' . $type . '/' . self::safe_name($item);
            if ($type === 'plugin') {
                $dir = dirname($item);
                $live = wp_normalize_path(WP_PLUGIN_DIR . '/' . ($dir === '.' ? $item : $dir));
                $source = $meta['is_dir'] ? $snap : $snap . '/' . basename($item);
            } else {
                $live = wp_normalize_path(get_theme_root($item) . '/' . $item);
                $source = $snap;
            }
            try {
                $aside = $root . '/failed/' . $type . '/' . self::safe_name($item) . '-' . time();
                wp_mkdir_p(dirname($aside));
                if (file_exists($live) && !@rename($live, $aside)) {
                    self::delete_tree($live);
                }
                self::copy_tree($source, $live);
                if ($type === 'plugin') {
                    wp_clean_plugins_cache(false);
                    if (!empty($meta['active']) && !is_plugin_active($item)) {
                        activate_plugin($item, '', false, true);
                    }
                } else {
                    wp_clean_themes_cache();
                }
                $out[] = array('type' => $type, 'item' => $item, 'ok' => true, 'version' => $meta['version'], 'message' => 'Revenit la ' . $meta['version'] . '.');
            } catch (Exception $e) {
                $out[] = array('type' => $type, 'item' => $item, 'ok' => false, 'message' => $e->getMessage());
            }
        }
        $db = null;
        if (!empty($params['db'])) {
            $db = self::import_db($root . '/database.sql.gz');
        }
        $core = null;
        if (!empty($params['core_version'])) {
            $ready = self::load_upgrader();
            $core = is_wp_error($ready) ? array('ok' => false, 'message' => $ready->get_error_message()) : self::install_core_version((string) $params['core_version']);
        }
        DAX_Events::log('rollback_done', 'DAX', array('items' => $out, 'db' => $db, 'core' => $core));
        return array('items' => $out, 'db' => $db, 'core' => $core);
    }

    /** Șterge copiile vechi (păstrează ultimele $keep rulări). */
    public static function cleanup($params)
    {
        $keep = isset($params['keep']) ? max(1, (int) $params['keep']) : 3;
        $root = self::snapshot_root();
        $runs = array();
        foreach ((array) glob($root . '/*', GLOB_ONLYDIR) as $dir) {
            $runs[$dir] = (int) @filemtime($dir);
        }
        arsort($runs);
        $removed = array();
        foreach (array_slice(array_keys($runs), $keep) as $dir) {
            if (self::delete_tree($dir)) {
                $removed[] = basename($dir);
            }
        }
        return array('removed' => $removed, 'kept' => min($keep, count($runs)));
    }

    // ---------------------------------------------------------------- baza de date

    public static function sql_value($value)
    {
        global $wpdb;
        if ($value === null) {
            return 'NULL';
        }
        $escaped = esc_sql((string) $value);
        if (method_exists($wpdb, 'remove_placeholder_escape')) {
            $escaped = $wpdb->remove_placeholder_escape($escaped);
        }
        return "'" . $escaped . "'";
    }

    /** Exportă tabelele WordPress (prefixul site-ului) într-un fișier SQL comprimat, o comandă pe rând. */
    private static function export_db($file)
    {
        global $wpdb;
        $gz = @gzopen($file, 'wb6');
        if (!$gz) {
            return array('ok' => false, 'message' => 'Nu pot scrie copia bazei de date.');
        }
        $tables = $wpdb->get_col($wpdb->prepare('SHOW TABLES LIKE %s', $wpdb->esc_like($wpdb->prefix) . '%'));
        $bytes = 0;
        $rows = 0;
        gzwrite($gz, "SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\n");
        foreach ($tables as $table) {
            $create = $wpdb->get_row('SHOW CREATE TABLE `' . esc_sql($table) . '`', ARRAY_N);
            if (!$create || empty($create[1])) {
                continue;
            }
            gzwrite($gz, 'DROP TABLE IF EXISTS `' . $table . "`;\n" . preg_replace('/\s*\n\s*/', ' ', $create[1]) . ";\n");
            $offset = 0;
            do {
                $batch = $wpdb->get_results('SELECT * FROM `' . esc_sql($table) . '` LIMIT ' . (int) $offset . ', 200', ARRAY_A);
                $values = array();
                $size = 0;
                foreach ((array) $batch as $row) {
                    $line = '(' . implode(',', array_map(array(__CLASS__, 'sql_value'), array_values($row))) . ')';
                    $values[] = $line;
                    $size += strlen($line);
                    $rows++;
                    if ($size > 1048576) {
                        gzwrite($gz, 'INSERT INTO `' . $table . '` VALUES ' . implode(',', $values) . ";\n");
                        $bytes += $size;
                        $values = array();
                        $size = 0;
                    }
                }
                if ($values) {
                    gzwrite($gz, 'INSERT INTO `' . $table . '` VALUES ' . implode(',', $values) . ";\n");
                    $bytes += $size;
                }
                if ($bytes > self::DB_LIMIT) {
                    gzclose($gz);
                    @unlink($file);
                    return array('ok' => false, 'message' => 'Baza de date e prea mare pentru o copie rapidă (peste 300 MB); se bazează pe backup-ul zilnic.');
                }
                $offset += 200;
            } while (count((array) $batch) === 200);
        }
        gzwrite($gz, "SET FOREIGN_KEY_CHECKS=1;\n");
        gzclose($gz);
        return array('ok' => true, 'tables' => count($tables), 'rows' => $rows, 'bytes' => (int) filesize($file));
    }

    private static function import_db($file)
    {
        global $wpdb;
        if (!file_exists($file)) {
            return array('ok' => false, 'message' => 'Nu există copie a bazei de date pentru această rulare.');
        }
        $gz = @gzopen($file, 'rb');
        if (!$gz) {
            return array('ok' => false, 'message' => 'Nu pot citi copia bazei de date.');
        }
        $count = 0;
        $errors = array();
        while (!gzeof($gz)) {
            $line = gzgets($gz, 33554432);
            if ($line === false) {
                break;
            }
            $line = trim($line);
            if ($line === '') {
                continue;
            }
            if ($wpdb->query($line) === false) {
                $errors[] = substr((string) $wpdb->last_error, 0, 200);
                if (count($errors) >= 5) {
                    break;
                }
            }
            $count++;
        }
        gzclose($gz);
        wp_cache_flush();
        return array('ok' => !$errors, 'statements' => $count, 'message' => $errors ? implode(' | ', $errors) : 'Baza de date a fost restaurată.');
    }
}
