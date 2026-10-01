<?php
/**
 * Exemplu. Arhiva descărcată din aplicația DAX conține un config.php completat automat.
 * Poți copia acest fișier ca config.php și completa manual valorile din aplicație.
 */

if (!defined('ABSPATH')) {
    exit;
}

if (!defined('DAX_SECRET')) {
    define('DAX_SECRET', '');
}
if (!defined('DAX_AGENT_URL')) {
    define('DAX_AGENT_URL', '');
}
