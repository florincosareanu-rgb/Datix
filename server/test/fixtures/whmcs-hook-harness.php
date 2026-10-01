<?php
/**
 * Mini-WHMCS pentru teste: încarcă hook-ul Datix AI și declanșează evenimentele cerute.
 * Intrare (stdin, JSON): { url, secret, fire: [{ hook, vars }] }
 */

define('WHMCS', true);
$input = json_decode(stream_get_contents(STDIN), true);
define('DATIX_AI_URL', $input['url']);
define('DATIX_AI_SECRET', $input['secret']);

$GLOBALS['__hooks'] = array();
function add_hook($name, $priority, $fn) { $GLOBALS['__hooks'][$name][] = $fn; }
function logActivity($message) { fwrite(STDERR, "logActivity: $message\n"); }

require dirname(__DIR__, 3) . '/integrations/whmcs/datix_ai.php';

$registered = array_keys($GLOBALS['__hooks']);
sort($registered);
foreach ($input['fire'] as $f) {
    foreach ($GLOBALS['__hooks'][$f['hook']] as $fn) {
        $fn($f['vars']);
    }
}
echo json_encode(array('registered' => $registered));
