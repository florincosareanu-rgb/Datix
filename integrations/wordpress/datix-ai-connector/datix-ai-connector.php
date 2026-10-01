<?php
/**
 * Plugin Name:       Datix AI Connector
 * Plugin URI:        https://datix.ro
 * Description:       Conectează site-ul la agentul Datix AI: stare, actualizări, securitate, mod mentenanță și jurnal de evenimente. Fiecare cerere a agentului este semnată (HMAC-SHA256) și verificată.
 * Version:           1.0.0
 * Requires at least: 5.8
 * Requires PHP:      7.2
 * Author:            Datix
 * Author URI:        https://datix.ro
 * License:           GPLv2 or later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       datix-ai-connector
 *
 * Cod compatibil cu PHP 7.2+ (fără funcții din PHP 8), ca să meargă pe orice hosting.
 */

if (!defined('ABSPATH')) {
    exit;
}

define('DATIX_AI_CONNECTOR_VERSION', '1.0.0');
define('DATIX_AI_CONNECTOR_FILE', __FILE__);
define('DATIX_AI_CONNECTOR_DIR', plugin_dir_path(__FILE__));

// Cheia de conectare și adresa agentului, generate la descărcarea pluginului din aplicația Datix AI.
// Alternativ, pot fi definite în wp-config.php: DATIX_AI_SECRET și DATIX_AI_AGENT_URL.
if (file_exists(DATIX_AI_CONNECTOR_DIR . 'config.php')) {
    require_once DATIX_AI_CONNECTOR_DIR . 'config.php';
}

require_once DATIX_AI_CONNECTOR_DIR . 'includes/class-datix-ai-config.php';
require_once DATIX_AI_CONNECTOR_DIR . 'includes/class-datix-ai-auth.php';
require_once DATIX_AI_CONNECTOR_DIR . 'includes/class-datix-ai-events.php';
require_once DATIX_AI_CONNECTOR_DIR . 'includes/class-datix-ai-protect.php';
require_once DATIX_AI_CONNECTOR_DIR . 'includes/class-datix-ai-audit.php';
require_once DATIX_AI_CONNECTOR_DIR . 'includes/class-datix-ai-api.php';

register_activation_hook(__FILE__, 'datix_ai_connector_activate');
register_deactivation_hook(__FILE__, 'datix_ai_connector_deactivate');

function datix_ai_connector_activate()
{
    Datix_AI_Events::install();
}

function datix_ai_connector_deactivate()
{
    wp_clear_scheduled_hook(Datix_AI_Events::CRON_HOOK);
}

// Protecțiile (XML-RPC, editor de fișiere) trebuie aplicate cât mai devreme.
Datix_AI_Protect::init();
Datix_AI_Events::init();
Datix_AI_API::init();

add_action('plugins_loaded', array('Datix_AI_Events', 'maybe_upgrade'));

if (is_admin()) {
    require_once DATIX_AI_CONNECTOR_DIR . 'includes/class-datix-ai-admin.php';
    Datix_AI_Admin::init();
}
