(function() {
  // Ochrana před vícenásobnou inicializací
  if (window.AuraGuardSDK) return;

  // Najdeme script tag, kterým byl tento soubor vložen
  var currentScript = document.currentScript;
  if (!currentScript) {
    var scripts = document.getElementsByTagName('script');
    for (var i = 0; i < scripts.length; i++) {
      if (scripts[i].src && scripts[i].src.indexOf('auraguard.js') !== -1) {
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

  // Odesílací funkce
  function sendReport(type, data) {
    var payload = {
      project: projectId,
      type: type,
      data: data,
      timestamp: new Date().toISOString()
    };

    var payloadStr = JSON.stringify(payload);

    // Preferujeme sendBeacon (zajistí odeslání i při zavírání okna)
    if (navigator.sendBeacon) {
      var blob = new Blob([payloadStr], { type: 'application/json' });
      navigator.sendBeacon(reportEndpoint, blob);
    } else {
      // Fallback pro starší prohlížeče
      var xhr = new XMLHttpRequest();
      xhr.open('POST', reportEndpoint, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(payloadStr);
    }
  }

  // 1. Záchyt JS chyb (Unhandled exceptions)
  window.addEventListener('error', function(event) {
    var errorData = {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      url: window.location.href,
      userAgent: navigator.userAgent
    };

    if (event.error) {
      errorData.stack = event.error.stack;
    }

    sendReport('error', errorData);
  });

  // 2. Záchyt asynchronních chyb (Unhandled Promise Rejections)
  window.addEventListener('unhandledrejection', function(event) {
    var errorData = {
      message: 'Unhandled Promise Rejection: ' + (event.reason ? (event.reason.message || event.reason) : 'Unknown'),
      url: window.location.href,
      userAgent: navigator.userAgent
    };

    if (event.reason && event.reason.stack) {
      errorData.stack = event.reason.stack;
    }

    sendReport('promise_rejection', errorData);
  });

  window.AuraGuardSDK = {
    version: '1.0.0',
    projectId: projectId,
    captureMessage: function(msg) {
      sendReport('message', { message: msg, url: window.location.href });
    },
    captureError: function(err) {
      sendReport('error', {
        message: err.message,
        stack: err.stack,
        url: window.location.href
      });
    }
  };

  console.log('AuraGuard SDK inicializováno pro projekt:', projectId);
})();
