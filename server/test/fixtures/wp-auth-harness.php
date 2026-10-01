<?php
/**
 * Mini-WordPress pentru teste: doar funcțiile folosite de DAX_Auth / DAX_Config.
 * Intrare (stdin, JSON): { secret, mode: "verify"|"sign", requests?: [...], path?, body? }
 * Ieșire (stdout, JSON).
 */

define('ABSPATH', __DIR__ . '/');

$GLOBALS['__options'] = array();
$GLOBALS['__transients'] = array();

function get_option($k, $d = false) { return array_key_exists($k, $GLOBALS['__options']) ? $GLOBALS['__options'][$k] : $d; }
function update_option($k, $v, $a = null) { $GLOBALS['__options'][$k] = $v; return true; }
function get_transient($k) { return isset($GLOBALS['__transients'][$k]) ? $GLOBALS['__transients'][$k] : false; }
function set_transient($k, $v, $t = 0) { $GLOBALS['__transients'][$k] = $v; return true; }
function esc_url_raw($u) { return $u; }
function untrailingslashit($s) { return rtrim($s, '/\\'); }
function wp_rand() { return mt_rand(); }

class WP_Error
{
    public $code;
    public $message;
    public $data;
    public function __construct($code = '', $message = '', $data = '') { $this->code = $code; $this->message = $message; $this->data = $data; }
}

class Test_Request
{
    private $headers;
    private $route;
    private $body;
    public function __construct(array $headers, $route, $body)
    {
        $this->headers = array();
        foreach ($headers as $k => $v) {
            $this->headers[strtolower(str_replace('-', '_', $k))] = $v;
        }
        $this->route = $route;
        $this->body = $body;
    }
    public function get_header($k) { $k = strtolower(str_replace('-', '_', $k)); return isset($this->headers[$k]) ? $this->headers[$k] : null; }
    public function get_route() { return $this->route; }
    public function get_body() { return $this->body; }
}

$input = json_decode(stream_get_contents(STDIN), true);
define('DAX_SECRET', $input['secret']);

$root = dirname(__DIR__, 3) . '/integrations/wordpress/dax-connector/includes/';
require $root . 'class-dax-config.php';
require $root . 'class-dax-auth.php';

if ($input['mode'] === 'sign') {
    echo json_encode(DAX_Auth::sign_headers('POST', $input['path'], $input['body']));
    exit;
}

$out = array();
foreach ($input['requests'] as $r) {
    DAX_Auth::$agent_request = false;
    $res = DAX_Auth::permission(new Test_Request($r['headers'], $r['route'], $r['body']));
    $out[] = $res === true ? array('ok' => true, 'agent' => DAX_Auth::$agent_request) : array('ok' => false, 'status' => $res->data['status'], 'message' => $res->message);
}
echo json_encode($out);
