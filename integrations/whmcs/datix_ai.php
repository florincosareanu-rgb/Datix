<?php
/**
 * Datix AI — hook WHMCS
 *
 * Anunță instant agentul Datix AI despre: tichete noi și răspunsuri ale clienților, autentificări de admin,
 * comenzi, plăți, cereri de anulare, clienți noi și rularea cron-ului WHMCS.
 *
 * Instalare: copiază fișierul în folderul includes/hooks/ din WHMCS.
 * Fișierul descărcat din aplicația Datix AI (Setări → Integrări → WHMCS) are deja adresa și cheia completate.
 *
 * Siguranță:
 *  - trimite doar identificatori (ID tichet, ID client etc.), nu conținutul mesajelor sau date personale;
 *    agentul citește detaliile prin API-ul WHMCS, cu permisiunile pe care i le-ai dat;
 *  - fiecare cerere e semnată HMAC-SHA256 (marcaj de timp + nonce unic), deci nu poate fi falsificată sau reluată;
 *  - timp maxim de așteptare 5 secunde; dacă agentul nu răspunde, WHMCS funcționează normal.
 *
 * Compatibil PHP 7.2+ (WHMCS 8.x).
 */

if (!defined('WHMCS')) {
    die('Acest fișier nu poate fi accesat direct.');
}

if (!defined('DATIX_AI_URL')) {
    define('DATIX_AI_URL', '%%DATIX_AI_URL%%');
}
if (!defined('DATIX_AI_SECRET')) {
    define('DATIX_AI_SECRET', '%%DATIX_AI_SECRET%%');
}

if (!function_exists('datix_ai_configured')) {
    function datix_ai_configured()
    {
        return DATIX_AI_URL !== '' && strpos(DATIX_AI_URL, '%%') === false
            && strlen(DATIX_AI_SECRET) >= 16 && strpos(DATIX_AI_SECRET, '%%') === false;
    }

    /** Antetele semnate: timestamp \n nonce \n POST \n rută \n sha256(corp). */
    function datix_ai_sign_headers($path, $body, $secret)
    {
        $timestamp = (string) time();
        try {
            $nonce = bin2hex(random_bytes(16));
        } catch (Exception $e) {
            $nonce = md5(uniqid('', true) . mt_rand());
        }
        $canonical = $timestamp . "\n" . $nonce . "\nPOST\n" . $path . "\n" . hash('sha256', $body);
        return array(
            'X-Datix-Timestamp: ' . $timestamp,
            'X-Datix-Nonce: ' . $nonce,
            'X-Datix-Signature: ' . hash_hmac('sha256', $canonical, $secret),
        );
    }

    function datix_ai_client_ip()
    {
        foreach (array('HTTP_CF_CONNECTING_IP', 'REMOTE_ADDR') as $key) {
            if (!empty($_SERVER[$key]) && filter_var($_SERVER[$key], FILTER_VALIDATE_IP)) {
                return $_SERVER[$key];
            }
        }
        return '';
    }

    /** Notează în jurnalul WHMCS o eroare de trimitere, cel mult o dată pe oră. */
    function datix_ai_log_failure($message)
    {
        $marker = rtrim(sys_get_temp_dir(), '/\\') . DIRECTORY_SEPARATOR . 'datix_ai_whmcs_' . md5(DATIX_AI_URL) . '.log';
        $last = @file_exists($marker) ? (int) @file_get_contents($marker) : 0;
        if (time() - $last < 3600) {
            return;
        }
        @file_put_contents($marker, (string) time());
        if (function_exists('logActivity')) {
            logActivity('Datix AI: nu am putut anunța agentul — ' . $message);
        }
    }

    /** Trimite un eveniment către agent. Nu aruncă niciodată excepții. */
    function datix_ai_send($event, array $data)
    {
        try {
            if (!datix_ai_configured() || !function_exists('curl_init')) {
                return;
            }
            $path = '/api/webhooks/whmcs';
            $body = json_encode(array('event' => $event, 'data' => $data, 'sent_at' => time()), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            if ($body === false) {
                return;
            }
            $headers = datix_ai_sign_headers($path, $body, DATIX_AI_SECRET);
            $headers[] = 'Content-Type: application/json';
            $headers[] = 'User-Agent: DatixAI-WHMCS/1.0';
            $ch = curl_init(rtrim(DATIX_AI_URL, '/') . $path);
            curl_setopt_array($ch, array(
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => $body,
                CURLOPT_HTTPHEADER => $headers,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_CONNECTTIMEOUT => 3,
                CURLOPT_TIMEOUT => 5,
                CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_SSL_VERIFYPEER => true,
                CURLOPT_SSL_VERIFYHOST => 2,
            ));
            curl_exec($ch);
            $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $error = curl_error($ch);
            curl_close($ch);
            if ($code < 200 || $code >= 300) {
                datix_ai_log_failure($error !== '' ? $error : ('HTTP ' . $code));
            }
        } catch (Throwable $e) {
            datix_ai_log_failure($e->getMessage());
        }
    }

    function datix_ai_int($vars, $key)
    {
        return isset($vars[$key]) ? (int) $vars[$key] : null;
    }
}

// ------------------------------------------------------------------ tichete

add_hook('TicketOpen', 1, function ($vars) {
    datix_ai_send('ticket.open', array(
        'ticketid' => datix_ai_int($vars, 'ticketid'),
        'tid' => isset($vars['ticketmask']) ? (string) $vars['ticketmask'] : null,
        'userid' => datix_ai_int($vars, 'userid'),
        'deptid' => datix_ai_int($vars, 'deptid'),
        'deptname' => isset($vars['deptname']) ? (string) $vars['deptname'] : null,
        'priority' => isset($vars['priority']) ? (string) $vars['priority'] : null,
    ));
});

add_hook('TicketUserReply', 1, function ($vars) {
    datix_ai_send('ticket.reply', array(
        'ticketid' => datix_ai_int($vars, 'ticketid'),
        'replyid' => datix_ai_int($vars, 'replyid'),
        'userid' => datix_ai_int($vars, 'userid'),
        'deptid' => datix_ai_int($vars, 'deptid'),
        'deptname' => isset($vars['deptname']) ? (string) $vars['deptname'] : null,
        'status' => isset($vars['status']) ? (string) $vars['status'] : null,
    ));
});

// ------------------------------------------------------------------ securitate

add_hook('AdminLogin', 1, function ($vars) {
    datix_ai_send('admin.login', array(
        'adminid' => datix_ai_int($vars, 'adminid'),
        'username' => isset($vars['username']) ? (string) $vars['username'] : null,
        'ip' => datix_ai_client_ip(),
        'user_agent' => isset($_SERVER['HTTP_USER_AGENT']) ? substr((string) $_SERVER['HTTP_USER_AGENT'], 0, 300) : null,
    ));
});

// ------------------------------------------------------------------ business

add_hook('AfterShoppingCartCheckout', 1, function ($vars) {
    datix_ai_send('order.created', array(
        'orderid' => datix_ai_int($vars, 'OrderID'),
        'ordernumber' => isset($vars['OrderNumber']) ? (string) $vars['OrderNumber'] : null,
        'invoiceid' => datix_ai_int($vars, 'InvoiceID'),
        'amount' => isset($vars['TotalDue']) ? (string) $vars['TotalDue'] : null,
    ));
});

add_hook('InvoicePaid', 1, function ($vars) {
    datix_ai_send('invoice.paid', array('invoiceid' => datix_ai_int($vars, 'invoiceid')));
});

add_hook('CancellationRequest', 1, function ($vars) {
    datix_ai_send('cancellation.request', array(
        'userid' => datix_ai_int($vars, 'userid'),
        'relid' => datix_ai_int($vars, 'relid'),
        'type' => isset($vars['type']) ? (string) $vars['type'] : null,
        'reason' => isset($vars['reason']) ? substr((string) $vars['reason'], 0, 500) : null,
    ));
});

add_hook('ClientAdd', 1, function ($vars) {
    datix_ai_send('client.add', array('userid' => datix_ai_int($vars, 'userid')));
});

// ------------------------------------------------------------------ cron (semn că WHMCS funcționează)

add_hook('AfterCronJob', 1, function ($vars) {
    datix_ai_send('cron.heartbeat', array('at' => time()));
});
