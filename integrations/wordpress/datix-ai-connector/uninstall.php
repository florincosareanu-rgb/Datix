<?php
/**
 * Dezinstalare: șterge tabelul de evenimente, setările și programările pluginului.
 */

if (!defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}

global $wpdb;

$datix_ai_table = $wpdb->prefix . 'datix_ai_events';
$wpdb->query("DROP TABLE IF EXISTS {$datix_ai_table}");

foreach (array(
    'datix_ai_connector_settings',
    'datix_ai_connector_last_seen',
    'datix_ai_connector_hardening',
    'datix_ai_connector_maintenance',
    'datix_ai_connector_db',
    'datix_ai_connector_known_modified',
) as $datix_ai_option) {
    delete_option($datix_ai_option);
}

wp_clear_scheduled_hook('datix_ai_connector_daily');
delete_metadata('user', 0, 'datix_ai_last_login', '', true);
