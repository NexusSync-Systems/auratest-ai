(function() {
  // Ochrana před vícenásobnou inicializací
  if (window.AuraGuardSDK) return;

  // Najdeme script tag, kterým byl tento soubor vložen
  var currentScript = document.currentScript;
  if (!currentScript) {
    var scripts = document.getElementsByTagName('script');
    for (var i = 0; i < scripts.length; i++) {
      // Match na konec cesty, ne na výskyt kdekoli v URL — jinak by se
      // konfigurace mohla vzít z cizího nebo starého tagu.
      if (scripts[i].src && /\/auraguard\.js(\?|$)/.test(scripts[i].src)) {
        currentScript = scripts[i];
        break;
      }
    }
  }

  var projectId = currentScript ? currentScript.getAttribute('data-project-id') : null;
  // Fallback endpoint, pokud se nezadá, předpokládáme server, ze kterého se stáhlo SDK
  var reportEndpoint = currentScript ? currentScript.getAttribute('data-endpoint') : null;

  if (!reportEndpoint && currentScript && currentScript.src) {
    try {
      var scriptUrl = new URL(currentScript.src);
      reportEndpoint = scriptUrl.origin + '/api/auraguard/report';
    } catch (e) {
      reportEndpoint = '/api/auraguard/report';
    }
  }

  if (!projectId) {
    console.warn('AuraGuard SDK: Nenalezen data-project-id na script tagu.');
    return;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Limity. SDK běží na webu zákazníka a nesmí ho zatížit ani rozbít.
  // Bez stropu vygeneruje chyba v requestAnimationFrame nebo setInterval
  // tisíce reportů za sekundu.
  // ───────────────────────────────────────────────────────────────────────────
  var MAX_REPORTS_PER_PAGE = 25;
  var MAX_FIELD_LENGTH = 4096;
  var reportCount = 0;
  var seenSignatures = {};
  var isSending = false;

  /**
   * Adresa bez query a fragmentu.
   *
   * `location.href` posílalo celé URL včetně `?reset_token=…` a
   * `#access_token=…`. Serverová PII redakce zná jen e-maily, karty
   * a telefony — tokeny by prošly rovnou do databáze.
   */
  function safeLocation() {
    try {
      return window.location.origin + window.location.pathname;
    } catch (e) {
      return '';
    }
  }

  /** Firestore dokument má limit 1 MiB; dlouhý stack by zápis shodil. */
  function truncate(value) {
    if (typeof value !== 'string') return value;
    return value.length > MAX_FIELD_LENGTH
      ? value.slice(0, MAX_FIELD_LENGTH) + '…[zkráceno]'
      : value;
  }

  // Odesílací funkce
  function sendReport(type, data) {
    // Ochrana proti rekurzi: kdyby cokoli uvnitř vyhodilo výjimku, spustil by
    // se globální 'error' listener a zavolal sendReport znovu.
    if (isSending) return;
    if (reportCount >= MAX_REPORTS_PER_PAGE) return;

    isSending = true;
    try {
      var signature = type + '|' + (data.message || '') + '|' + (data.filename || '') + '|' + (data.lineno || '');
      if (seenSignatures[signature]) return;
      seenSignatures[signature] = true;
      reportCount++;

      var safeData = {};
      for (var key in data) {
        if (Object.prototype.hasOwnProperty.call(data, key)) {
          safeData[key] = truncate(data[key]);
        }
      }

      var payloadStr = JSON.stringify({
        project: projectId,
        type: type,
        data: safeData,
        timestamp: new Date().toISOString()
      });

      // Preferujeme sendBeacon (zajistí odeslání i při zavírání okna).
      // Vrací false, když se požadavek nepodařilo zařadit do fronty —
      // dřív se návratová hodnota ignorovala a report tiše zmizel.
      var queued = false;
      if (navigator.sendBeacon) {
        try {
          var blob = new Blob([payloadStr], { type: 'application/json' });
          queued = navigator.sendBeacon(reportEndpoint, blob);
        } catch (e) {
          queued = false;
        }
      }

      if (!queued) {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', reportEndpoint, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(payloadStr);
      }
    } catch (e) {
      // SDK nikdy nesmí rozbít web zákazníka.
    } finally {
      isSending = false;
    }
  }

  // 1. Záchyt JS chyb (Unhandled exceptions)
  window.addEventListener('error', function(event) {
    try {
      if (!event || !event.message) return;

      var errorData = {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        url: safeLocation(),
        userAgent: navigator.userAgent
      };

      if (event.error) {
        errorData.stack = event.error.stack;
      }

      sendReport('error', errorData);
    } catch (e) {
      // ticho — viz výše
    }
  });

  // 2. Záchyt asynchronních chyb (Unhandled Promise Rejections)
  window.addEventListener('unhandledrejection', function(event) {
    try {
      var reason = event ? event.reason : null;
      var errorData = {
        message: 'Unhandled Promise Rejection: ' + (reason ? (reason.message || String(reason)) : 'Unknown'),
        url: safeLocation(),
        userAgent: navigator.userAgent
      };

      if (reason && reason.stack) {
        errorData.stack = reason.stack;
      }

      sendReport('promise_rejection', errorData);
    } catch (e) {
      // ticho — viz výše
    }
  });

  window.AuraGuardSDK = {
    version: '1.1.0',
    projectId: projectId,
    captureMessage: function(msg) {
      sendReport('message', { message: String(msg), url: safeLocation() });
    },
    captureError: function(err) {
      sendReport('error', {
        message: err && err.message ? err.message : String(err),
        stack: err ? err.stack : undefined,
        url: safeLocation()
      });
    }
  };

  if (currentScript && currentScript.getAttribute('data-debug') === 'true') {
    console.log('AuraGuard SDK inicializováno pro projekt:', projectId);
  }
})();
