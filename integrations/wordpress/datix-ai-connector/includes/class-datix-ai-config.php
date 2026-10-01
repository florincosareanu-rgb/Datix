<?php
/**
 * Configurarea pluginului: cheia de conectare, adresa agentului, ultima conectare.
 */

if (!defined('ABSPATH')) {
    exit;
}

final class Datix_AI_Config
{
    const OPTION = 'datix_ai_connector_settings';
    const LAST_SEEN = 'datix_ai_connector_last_seen';

    /** @return array */
    public static function options()
    {
        $o = get_option(self::OPTION, array());
        return is_array($o) ? $o : array();
    }

    public static function update(array $patch)
    {
        update_option(self::OPTION, array_merge(self::options(), $patch), false);
    }

    /** Cheia secretă comună cu agentul (din wp-config.php, config.php sau setările pluginului). */
    public static function secret()
    {
        if (defined('DATIX_AI_SECRET') && is_string(DATIX_AI_SECRET) && DATIX_AI_SECRET !== '') {
            return DATIX_AI_SECRET;
        }
        $o = self::options();
        return isset($o['secret']) ? (string) $o['secret'] : '';
    }

    /** De unde vine cheia: 'constant', 'database' sau '' (lipsă). */
    public static function secret_source()
    {
        if (defined('DATIX_AI_SECRET') && is_string(DATIX_AI_SECRET) && DATIX_AI_SECRET !== '') {
            return 'constant';
        }
        $o = self::options();
        return !empty($o['secret']) ? 'database' : '';
    }

    /** Adresa agentului (ex. https://ai.datix.ro), fără „/” la final. */
    public static function agent_url()
    {
        $url = '';
        if (defined('DATIX_AI_AGENT_URL') && is_string(DATIX_AI_AGENT_URL)) {
            $url = DATIX_AI_AGENT_URL;
        } else {
            $o = self::options();
            $url = isset($o['agent_url']) ? (string) $o['agent_url'] : '';
        }
        $url = esc_url_raw(trim($url));
        return $url === '' ? '' : untrailingslashit($url);
    }

    public static function is_configured()
    {
        return strlen(self::secret()) >= 16;
    }

    /** Ține minte ultima cerere validă de la agent (scrie în baza de date cel mult o dată pe minut). */
    public static function touch_last_seen($ip)
    {
        $prev = get_option(self::LAST_SEEN, array());
        if (is_array($prev) && isset($prev['at']) && time() - (int) $prev['at'] < 60 && isset($prev['ip']) && $prev['ip'] === $ip) {
            return;
        }
        update_option(self::LAST_SEEN, array('at' => time(), 'ip' => (string) $ip), false);
    }

    /** @return array|null */
    public static function last_seen()
    {
        $v = get_option(self::LAST_SEEN, null);
        return is_array($v) && isset($v['at']) ? $v : null;
    }
}
