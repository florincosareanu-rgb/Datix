<?php
/**
 * Verificarea cererilor de la agent și semnarea evenimentelor trimise către agent.
 *
 * Mesajul semnat (identic cu serverul DAX):
 *   timestamp \n nonce \n METODĂ \n rută \n sha256(corp)
 * Antete: X-Datix-Timestamp, X-Datix-Nonce, X-Datix-Signature (HMAC-SHA256, hex).
 */

if (!defined('ABSPATH')) {
    exit;
}

final class DAX_Auth
{
    const MAX_SKEW = 300;
    const MAX_FAILURES = 20;
    const LOCK_WINDOW = 600;

    /** Adevărat după ce cererea curentă a fost verificată ca venind de la agent. */
    public static $agent_request = false;

    /** IP-ul vizitatorului (informativ — pentru jurnal și limitarea încercărilor). */
    public static function client_ip()
    {
        $candidates = array();
        if (!empty($_SERVER['HTTP_CF_CONNECTING_IP'])) {
            $candidates[] = $_SERVER['HTTP_CF_CONNECTING_IP'];
        }
        if (!empty($_SERVER['REMOTE_ADDR'])) {
            $candidates[] = $_SERVER['REMOTE_ADDR'];
        }
        foreach ($candidates as $ip) {
            $ip = trim((string) $ip);
            if (filter_var($ip, FILTER_VALIDATE_IP)) {
                return $ip;
            }
        }
        return '0.0.0.0';
    }

    public static function canonical($timestamp, $nonce, $method, $path, $body)
    {
        return $timestamp . "\n" . $nonce . "\n" . strtoupper($method) . "\n" . $path . "\n" . hash('sha256', (string) $body);
    }

    /** permission_callback pentru toate rutele agentului. */
    public static function permission($request)
    {
        $secret = DAX_Config::secret();
        if (strlen($secret) < 16) {
            return new WP_Error('dax_not_configured', 'Pluginul DAX nu are cheia de conectare configurată (DAX_SECRET).', array('status' => 503));
        }
        $ip = self::client_ip();
        $lock_key = 'dax_fail_' . md5($ip);
        $failures = (int) get_transient($lock_key);
        if ($failures >= self::MAX_FAILURES) {
            return new WP_Error('dax_locked', 'Prea multe încercări eșuate de pe acest IP. Reîncearcă peste 10 minute.', array('status' => 429));
        }

        $timestamp = (string) $request->get_header('x_datix_timestamp');
        $nonce = (string) $request->get_header('x_datix_nonce');
        $signature = strtolower((string) $request->get_header('x_datix_signature'));

        $error = null;
        if ($timestamp === '' || $nonce === '' || $signature === '') {
            $error = array('Antete de semnătură lipsă.', 401);
        } elseif (!preg_match('/^\d{9,12}$/', $timestamp) || !preg_match('/^[A-Za-z0-9_-]{8,128}$/', $nonce) || !preg_match('/^[a-f0-9]{64}$/', $signature)) {
            $error = array('Antete de semnătură invalide.', 401);
        } else {
            $skew = abs(time() - (int) $timestamp);
            if ($skew > self::MAX_SKEW) {
                $error = array(sprintf('Ceasul serverului diferă cu %d secunde față de agent. Verifică ora serverului.', $skew), 401);
            } else {
                $expected = hash_hmac('sha256', self::canonical($timestamp, $nonce, 'POST', $request->get_route(), $request->get_body()), $secret);
                if (!hash_equals($expected, $signature)) {
                    $error = array('Semnătură invalidă — cheia de conectare nu corespunde cu cea din aplicația DAX.', 403);
                } else {
                    $nonce_key = 'dax_n_' . md5($nonce);
                    if (get_transient($nonce_key)) {
                        $error = array('Cerere repetată.', 409);
                    } else {
                        set_transient($nonce_key, 1, self::MAX_SKEW * 2 + 60);
                    }
                }
            }
        }

        if ($error !== null) {
            set_transient($lock_key, $failures + 1, self::LOCK_WINDOW);
            return new WP_Error('dax_auth', $error[0], array('status' => $error[1]));
        }

        self::$agent_request = true;
        DAX_Config::touch_last_seen($ip);
        return true;
    }

    /** Antetele pentru o cerere semnată către agent. */
    public static function sign_headers($method, $path, $body)
    {
        $timestamp = (string) time();
        try {
            $nonce = bin2hex(random_bytes(16));
        } catch (Exception $e) {
            $nonce = md5(uniqid('', true) . wp_rand());
        }
        $signature = hash_hmac('sha256', self::canonical($timestamp, $nonce, $method, $path, $body), DAX_Config::secret());
        return array(
            'X-Datix-Timestamp' => $timestamp,
            'X-Datix-Nonce' => $nonce,
            'X-Datix-Signature' => $signature,
        );
    }
}
