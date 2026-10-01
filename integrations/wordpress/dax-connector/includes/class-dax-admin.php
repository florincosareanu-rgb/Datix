<?php
/**
 * Pagina de setări din wp-admin: Setări → DAX.
 */

if (!defined('ABSPATH')) {
    exit;
}

final class DAX_Admin
{
    const SLUG = 'dax-connector';

    public static function init()
    {
        add_action('admin_menu', array(__CLASS__, 'menu'));
        add_action('admin_post_dax_save', array(__CLASS__, 'save'));
        add_action('admin_notices', array(__CLASS__, 'notice'));
        add_filter('plugin_action_links_' . plugin_basename(DAX_CONNECTOR_FILE), array(__CLASS__, 'action_links'));
    }

    public static function menu()
    {
        add_options_page('DAX', 'DAX', 'manage_options', self::SLUG, array(__CLASS__, 'page'));
    }

    public static function action_links($links)
    {
        array_unshift($links, '<a href="' . esc_url(admin_url('options-general.php?page=' . self::SLUG)) . '">Setări</a>');
        return $links;
    }

    public static function notice()
    {
        if (!current_user_can('manage_options') || DAX_Config::is_configured()) {
            return;
        }
        $screen = function_exists('get_current_screen') ? get_current_screen() : null;
        if ($screen && !in_array($screen->id, array('plugins', 'dashboard'), true)) {
            return;
        }
        echo '<div class="notice notice-warning"><p><strong>DAX Connector</strong> nu are cheia de conectare. ';
        echo 'Descarcă pluginul din aplicația DAX (Setări → Integrări → WordPress) — conține deja cheia — sau <a href="' . esc_url(admin_url('options-general.php?page=' . self::SLUG)) . '">introdu-o manual</a>.</p></div>';
    }

    public static function save()
    {
        if (!current_user_can('manage_options')) {
            wp_die('Nu ai permisiunea necesară.', 403);
        }
        check_admin_referer('dax_save');
        $section = isset($_POST['section']) ? sanitize_key(wp_unslash($_POST['section'])) : '';
        if ($section === 'connection' && DAX_Config::secret_source() !== 'constant') {
            $patch = array();
            $secret = isset($_POST['secret']) ? trim((string) wp_unslash($_POST['secret'])) : '';
            if ($secret !== '') {
                $patch['secret'] = preg_replace('/[^A-Za-z0-9_\-\.=+\/]/', '', $secret);
            }
            if (!defined('DAX_AGENT_URL') && isset($_POST['agent_url'])) {
                $patch['agent_url'] = esc_url_raw(trim((string) wp_unslash($_POST['agent_url'])), array('https', 'http'));
            }
            DAX_Config::update($patch);
        } elseif ($section === 'hardening') {
            DAX_Protect::set_hardening(array(
                'disable_xmlrpc' => !empty($_POST['disable_xmlrpc']),
                'block_user_enum' => !empty($_POST['block_user_enum']),
                'disable_file_edit' => !empty($_POST['disable_file_edit']),
            ));
            DAX_Events::log('hardening_changed', wp_get_current_user()->user_login, DAX_Protect::hardening());
        } elseif ($section === 'maintenance') {
            $enabled = !empty($_POST['maintenance_enabled']);
            $message = isset($_POST['maintenance_message']) ? (string) wp_unslash($_POST['maintenance_message']) : '';
            DAX_Protect::set_maintenance($enabled, $message);
            DAX_Events::log($enabled ? 'maintenance_on' : 'maintenance_off', wp_get_current_user()->user_login, $message);
        }
        wp_safe_redirect(add_query_arg(array('page' => self::SLUG, 'saved' => '1'), admin_url('options-general.php')));
        exit;
    }

    private static function row($label, $value)
    {
        echo '<tr><th scope="row">' . esc_html($label) . '</th><td>' . $value . '</td></tr>';
    }

    public static function page()
    {
        if (!current_user_can('manage_options')) {
            return;
        }
        $source = DAX_Config::secret_source();
        $agent = DAX_Config::agent_url();
        $seen = DAX_Config::last_seen();
        $h = DAX_Protect::hardening();
        $m = DAX_Protect::maintenance();
        $action = esc_url(admin_url('admin-post.php'));

        echo '<div class="wrap"><h1>DAX Connector</h1>';
        if (!empty($_GET['saved'])) {
            echo '<div class="notice notice-success is-dismissible"><p>Salvat.</p></div>';
        }
        echo '<p>Pluginul permite agentului DAX să verifice starea site-ului, actualizările și securitatea, și să intervină când site-ul are probleme. Fiecare cerere a agentului este semnată și verificată; fără cheia corectă, nimeni nu poate folosi aceste funcții.</p>';

        // ---- conexiune
        echo '<h2>Conexiune</h2><table class="form-table" role="presentation"><tbody>';
        if ($seen) {
            self::row('Stare', '<span style="color:#00a32a">●</span> Conectat — ultima cerere a agentului: ' . esc_html(human_time_diff((int) $seen['at'])) . ' în urmă (IP ' . esc_html($seen['ip']) . ')');
        } else {
            self::row('Stare', DAX_Config::is_configured() ? 'Așteaptă prima cerere de la agent. Apasă „Testează conexiunea” în aplicația DAX.' : '<strong>Neconfigurat</strong>');
        }
        self::row('Cheia de conectare', $source === 'constant' ? 'setată în fișierul de configurare (config.php sau wp-config.php)' : ($source === 'database' ? 'setată din această pagină' : '<strong>lipsește</strong>'));
        self::row('Adresa agentului', $agent !== '' ? '<code>' . esc_html($agent) . '</code>' : '<em>nesetată — evenimentele de securitate nu sunt trimise instant</em>');
        echo '</tbody></table>';

        if ($source !== 'constant') {
            echo '<form method="post" action="' . $action . '">';
            wp_nonce_field('dax_save');
            echo '<input type="hidden" name="action" value="dax_save"><input type="hidden" name="section" value="connection">';
            echo '<table class="form-table" role="presentation"><tbody>';
            self::row('Cheie nouă', '<input type="password" name="secret" class="regular-text" autocomplete="off" placeholder="' . ($source ? 'lasă gol ca să o păstrezi' : 'din aplicația DAX') . '"><p class="description">O găsești în aplicația DAX → Setări → Integrări → WordPress → „Arată cheia pluginului”.</p>');
            if (!defined('DAX_AGENT_URL')) {
                self::row('Adresa agentului', '<input type="url" name="agent_url" class="regular-text" value="' . esc_attr($agent) . '" placeholder="https://dax.datix.ro">');
            }
            echo '</tbody></table>';
            submit_button('Salvează conexiunea');
            echo '</form>';
        }

        // ---- protecții
        echo '<h2>Protecții</h2><form method="post" action="' . $action . '">';
        wp_nonce_field('dax_save');
        echo '<input type="hidden" name="action" value="dax_save"><input type="hidden" name="section" value="hardening">';
        echo '<fieldset>';
        echo '<p><label><input type="checkbox" name="disable_xmlrpc" value="1" ' . checked($h['disable_xmlrpc'], true, false) . '> Blochează XML-RPC (folosit des pentru atacuri de ghicire a parolei)</label></p>';
        echo '<p><label><input type="checkbox" name="block_user_enum" value="1" ' . checked($h['block_user_enum'], true, false) . '> Ascunde numele utilizatorilor (?author=, REST, sitemap)</label></p>';
        echo '<p><label><input type="checkbox" name="disable_file_edit" value="1" ' . checked($h['disable_file_edit'], true, false) . '> Dezactivează editorul de fișiere din wp-admin</label></p>';
        echo '</fieldset>';
        submit_button('Salvează protecțiile');
        echo '</form>';

        // ---- mentenanță
        echo '<h2>Mod mentenanță</h2><form method="post" action="' . $action . '">';
        wp_nonce_field('dax_save');
        echo '<input type="hidden" name="action" value="dax_save"><input type="hidden" name="section" value="maintenance">';
        echo '<p><label><input type="checkbox" name="maintenance_enabled" value="1" ' . checked($m['enabled'], true, false) . '> Afișează vizitatorilor pagina de mentenanță (tu, autentificat, vezi site-ul normal)</label></p>';
        echo '<p><textarea name="maintenance_message" rows="2" class="large-text" placeholder="Facem câteva lucrări de întreținere. Revenim în câteva minute.">' . esc_textarea($m['message']) . '</textarea></p>';
        submit_button('Salvează');
        echo '</form>';

        // ---- jurnal
        echo '<h2>Jurnal de securitate (ultimele 50)</h2>';
        $events = DAX_Events::recent(0, 50);
        if (!$events) {
            echo '<p>Niciun eveniment încă.</p>';
        } else {
            echo '<table class="widefat striped"><thead><tr><th>Când</th><th>Eveniment</th><th>Utilizator</th><th>IP</th><th>Detalii</th></tr></thead><tbody>';
            foreach ($events as $e) {
                echo '<tr><td>' . esc_html(wp_date('Y-m-d H:i', $e['at'])) . '</td><td><code>' . esc_html($e['type']) . '</code></td><td>' . esc_html((string) $e['user']) . '</td><td>' . esc_html((string) $e['ip']) . '</td><td>' . esc_html(wp_trim_words((string) $e['details'], 20)) . '</td></tr>';
            }
            echo '</tbody></table>';
        }
        echo '</div>';
    }
}
