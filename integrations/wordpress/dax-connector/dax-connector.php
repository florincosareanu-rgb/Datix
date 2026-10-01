<?php
/**
 * Plugin Name:       DAX Connector
 * Plugin URI:        https://datix.ro
 * Description:       Conectează site-ul la agentul DAX: stare, actualizări, securitate, mod mentenanță și jurnal de evenimente. Fiecare cerere a agentului este semnată (HMAC-SHA256) și verificată.
 * Version:           1.0.0
 * Requires at least: 5.8
 * Requires PHP:      7.2
 * Author:            Datix
 * Author URI:        https://datix.ro
 * License:           GPLv2 or later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       dax-connector
 *
 * Cod compatibil cu PHP 7.2+ (fără funcții din PHP 8), ca să meargă pe orice hosting.
 */

if (!defined('ABSPATH')) {
    exit;
}

define('DAX_CONNECTOR_VERSION', '1.0.0');
define('DAX_CONNECTOR_FILE', __FILE__);
define('DAX_CONNECTOR_DIR', plugin_dir_path(__FILE__));

// Cheia de conectare și adresa agentului, generate la descărcarea pluginului din aplicația DAX.
// Alternativ, pot fi definite în wp-config.php: DAX_SECRET și DAX_AGENT_URL.
if (file_exists(DAX_CONNECTOR_DIR . 'config.php')) {
    require_once DAX_CONNECTOR_DIR . 'config.php';
}

require_once DAX_CONNECTOR_DIR . 'includes/class-dax-config.php';
require_once DAX_CONNECTOR_DIR . 'includes/class-dax-auth.php';
require_once DAX_CONNECTOR_DIR . 'includes/class-dax-events.php';
require_once DAX_CONNECTOR_DIR . 'includes/class-dax-protect.php';
require_once DAX_CONNECTOR_DIR . 'includes/class-dax-audit.php';
require_once DAX_CONNECTOR_DIR . 'includes/class-dax-api.php';

register_activation_hook(__FILE__, 'dax_connector_activate');
register_deactivation_hook(__FILE__, 'dax_connector_deactivate');

function dax_connector_activate()
{
    DAX_Events::install();
}

function dax_connector_deactivate()
{
    wp_clear_scheduled_hook(DAX_Events::CRON_HOOK);
}

// Protecțiile (XML-RPC, editor de fișiere) trebuie aplicate cât mai devreme.
DAX_Protect::init();
DAX_Events::init();
DAX_API::init();

add_action('plugins_loaded', array('DAX_Events', 'maybe_upgrade'));

if (is_admin()) {
    require_once DAX_CONNECTOR_DIR . 'includes/class-dax-admin.php';
    DAX_Admin::init();
}
