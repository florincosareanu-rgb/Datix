<?php
/**
 * Dezinstalare: șterge tabelul de evenimente, setările și programările pluginului.
 */

if (!defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}

global $wpdb;

$dax_table = $wpdb->prefix . 'dax_events';
$wpdb->query("DROP TABLE IF EXISTS {$dax_table}");

foreach (array(
    'dax_connector_settings',
    'dax_connector_last_seen',
    'dax_connector_hardening',
    'dax_connector_maintenance',
    'dax_connector_db',
    'dax_connector_known_modified',
) as $dax_option) {
    delete_option($dax_option);
}

wp_clear_scheduled_hook('dax_connector_daily');
delete_metadata('user', 0, 'dax_last_login', '', true);
