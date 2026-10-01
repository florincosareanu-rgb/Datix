<?php
/**
 * Mini-WHMCS pentru teste: încarcă hook-ul DAX și declanșează evenimentele cerute.
 * Intrare (stdin, JSON): { url, secret, fire: [{ hook, vars }] }
 */

define('WHMCS', true);
$input = json_decode(stream_get_contents(STDIN), true);
define('DAX_URL', $input['url']);
define('DAX_SECRET', $input['secret']);

$GLOBALS['__hooks'] = array();
function add_hook($name, $priority, $fn) { $GLOBALS['__hooks'][$name][] = $fn; }
function logActivity($message) { fwrite(STDERR, "logActivity: $message\n"); }

require dirname(__DIR__, 3) . '/integrations/whmcs/dax.php';

$registered = array_keys($GLOBALS['__hooks']);
sort($registered);
foreach ($input['fire'] as $f) {
    foreach ($GLOBALS['__hooks'][$f['hook']] as $fn) {
        $fn($f['vars']);
    }
}
echo json_encode(array('registered' => $registered));
