'use strict';

var C = require('./constants');
var headers = C.headers;
var map = require('./map');

function getSDKVersion() {
  // NOTE(mroberts): Set by `Makefile'.
  /* eslint no-process-env:0 */
  return process.env.SDK_VERSION || 'unknown';
}

function makeSystemInfo() {
  var version = getSDKVersion();
  var nav = typeof navigator === 'undefined' ? {} : navigator;
  return {
    p: 'browser',
    v: version,
    browser: {
      userAgent: nav.userAgent || 'unknown',
      platform: nav.platform || 'unknown'
    },
    plugin: 'rtc'
  };
}

/**
 * Decode a base64url-encoded string.
 * @private
 * @param {string} encoded
 * @returns {string}
 */
function decodeBase64URL(encoded) {
  var remainder = encoded.length % 4;
  if (remainder > 0) {
    var padlen = 4 - remainder;
    encoded += new Array(padlen + 1).join('=');
  }
  encoded = encoded.replace(/-/g, '+')
                   .replace(/_/g, '/');
  return decodeBase64(encoded);
}

/**
 * Decode a base64-encoded string.
 * @private
 * @param {string} encoded
 * @returns {string}
 */
function decodeBase64(encoded) {
  return typeof atob === 'function'
    ? atob(encoded)
    : new Buffer(encoded, 'base64').toString();
}

// TODO(mrobers): Remove this function as soon as we move to FPA.
function selectTokenHeader(token) {
  var parts = token.split('.');
  var header;
  try {
    header = JSON.parse(decodeBase64URL(parts[0]));
  } catch (error) {
    return headers.X_TWILIO_ACCESSTOKEN;
  }
  return typeof header.cty === 'string' && header.cty.match(/^twilio-fpa/)
    ? headers.X_TWILIO_ACCESSTOKEN
    : headers.X_TWILIO_TOKEN;
}

/**
 * Construct an array of REGISTER headers.
 * @param {string} token - an Access Token
 * @returns {Array}
 */
function makeRegisterHeaders(token) {
  var systemInfo = makeSystemInfo();
  var cmg = [
    selectTokenHeader(token)       + ': ' + token,
    headers.X_TWILIO_CLIENT        + ': ' + JSON.stringify(systemInfo),
    headers.X_TWILIO_CLIENTVERSION + ': ' + C.CLIENT_VERSION
  ];
  return cmg;
}

/**
 * Construct the SIP URI for a client of a particular account.
 * @param {string} accountSid - the Account SID
 * @param {string} clientName - the client name
 * @returns {string}
 */
function makeSIPURI(accountSid, clientName) {
  /* eslint new-cap:0 */
  // TODO(mroberts): Fix this as soon as the following is fixed:
  // https://github.com/onsip/SIP.js/issues/286
  return encodeURIComponent(encodeURIComponent(clientName)) + '@' + C.REGISTRAR_SERVER(accountSid);
}

/**
 * Get the decoded user portion of a SIP URI.
 * @param {string} uri - the SIP URI
 * @returns {?string}
 */
function getUser(uri) {
  var SIPJS = require('sip.js');
  var result = SIPJS.Grammar.parse(uri, 'Contact');
  if (result !== -1 && result[0]) {
    return result[0].parsed.uri.user;
  }
  return null;
}

function makeUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0;
    var v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function withDefaults(destination, sources) {
  destination = destination || {};
  sources = Array.prototype.slice.call(arguments, 1);
  sources.forEach(function(source) {
    _withDefaults(destination, source);
  });

  return destination;
}
function _withDefaults(destination, source) {
  for (var key in source) {
    if (!(key in destination)) {
      destination[key] = source[key];
    }
  }

  return destination;
}

function extend(destination, sources) {
  destination = destination || {};
  sources = Array.prototype.slice.call(arguments, 1);
  sources.forEach(function(source) {
    _extend(destination, source);
  });

  return destination;
}
function _extend(destination, source) {
  for (var key in source) {
    destination[key] = source[key];
  }

  return destination;
}

function separateIceServers(iceServers) {
  var stunServers = [];
  var turnServers = [];
  if (iceServers) {
    iceServers.forEach(function(iceServer) {
      if (!iceServer.url) {
        return;
      }
      var schema = iceServer['url'].split(':')[0];
      if (schema === 'stun' || schema === 'stuns') {
        stunServers.push(iceServer);
      } else if (schema === 'turn' || schema === 'turns') {
        turnServers.push(iceServer);
      }
    });
  }
  stunServers = stunServers.map(function(stunServer) {
    return stunServer['url'].split('?')[0];
  });
  turnServers = turnServers.map(function(turnServer) {
    /* eslint dot-notation:0 */
    var url = turnServer['url'].split('?')[0];
    var username = turnServer['username'];
    var password = turnServer['credential'];
    return {
      urls: [url],
      username: username,
      password: password
    };
  });
  return { stunServers: stunServers, turnServers: turnServers };
}

function getStunServers(iceServers) {
  return separateIceServers(iceServers).stunServers;
}

function getTurnServers(iceServers) {
  return separateIceServers(iceServers).turnServers;
}

function promiseFromEvents(operation, eventEmitter, successEvent, failureEvent) {
  return new Promise(function(resolve, reject) {
    function onSuccess() {
      var args = [].slice.call(arguments);
      if (failureEvent) {
        eventEmitter.removeListener(failureEvent, onFailure);
      }
      resolve.apply(null, args);
    }
    function onFailure() {
      var args = [].slice.call(arguments);
      eventEmitter.removeListener(successEvent, onSuccess);
      reject.apply(null, args);
    }
    eventEmitter.once(successEvent, onSuccess);
    if (failureEvent) {
      eventEmitter.once(failureEvent, onFailure);
    }
    operation();
  });
}

function parseConversationSIDFromContactHeader(contactHeader) {
  var match = contactHeader.match(/<sip:(.*)@(.*)$/);
  return match ? match[1] : null;
}

/**
 * Traverse down multiple nodes on an object and return null if
 * any link in the path is unavailable.
 * @param {Object} obj - Object to traverse
 * @param {String} path - Path to traverse. Period-separated.
 * @returns {Any|null}
 */
function getOrNull(obj, path) {
  return path.split('.').reduce(function(output, step) {
    if (!output) { return null; }
    return output[step];
  }, obj);
}

/**
 * Parse the passed userAgent string down into a simple object.
 * Example browser object: { name: 'Chrome', version: '42.0' }
 * @returns {Object} Object containing a name and version.
 */
function parseUserAgent(ua) {
  var M = ua.match(/(opera|chrome|safari|firefox|msie|trident(?=\/))\/?\s*(\d+)\.(\d+)/i) || [];
  var specs = {
    name: M[1],
    version: typeof M[2] !== 'undefined' && typeof M[3] !== 'undefined' && M[2] + '.' + M[3]
  };

  var parts;

  if (/trident/i.test(specs.name)) {
    parts = /\brv[ :]+(\d+)\.(\d+)/g.exec(ua) || [];
    return { name: 'IE', version: parts[1] ? (parts[1] + '.' + parts[2]) : 'Unknown' };
  }

  if (specs.name === 'Chrome') {
    parts = ua.match(/\b(OPR|Edge)\/(\d+)\.(\d+)/);
    if (parts !== null) { return { name: 'Opera', version: parts[2] + '.' + parts[3] }; }
  }

  if (specs.name === 'MSIE') {
    specs.name = 'IE';
  }

  return {
    name: specs.name || 'Unknown',
    version: specs.version || 'Unknown'
  };
}

/**
 * Overwrite an existing Array with a new one. This is useful when the existing
 * Array is an immutable property of another object.
 * @param {Array} oldArray - the existing Array to overwrite
 * @param {Array} newArray - the new Array to overwrite with
 */
function overwriteArray(oldArray, newArray) {
  oldArray.splice(0, oldArray.length);
  newArray.forEach(function(item) {
    oldArray.push(item);
  });
}

function validateAddresses(accountSid, addresses) {
  var invalidAddresses = (addresses.forEach ? addresses : [addresses])
    .map(makeSIPURI.bind(accountSid))
    .filter(function(address) { return address.length > C.MAX_ADDRESS_LENGTH; });

  if (invalidAddresses.length) {
    throw new Error('Addresses must not exceed ' + C.MAX_ADDRESS_LENGTH + ' characters: ' + invalidAddresses);
  }
}

function defer() {
  var deferred = {};
  deferred.promise = new Promise(function(resolve, reject) {
    deferred.resolve = resolve;
    deferred.reject = reject;
  });
  return deferred;
}

module.exports.makeRegisterHeaders = makeRegisterHeaders;
module.exports.makeSIPURI = makeSIPURI;
module.exports.getUser = getUser;
module.exports.makeUUID = makeUUID;
module.exports.withDefaults = withDefaults;
module.exports.extend = extend;
module.exports.separateIceServers = separateIceServers;
module.exports.getStunServers = getStunServers;
module.exports.getTurnServers = getTurnServers;
module.exports.promiseFromEvents = promiseFromEvents;
module.exports.parseConversationSIDFromContactHeader = parseConversationSIDFromContactHeader;
module.exports.getOrNull = getOrNull;
module.exports.parseUserAgent = parseUserAgent;
module.exports.overwriteArray = overwriteArray;
module.exports.map = map;
module.exports.validateAddresses = validateAddresses;
module.exports.selectTokenHeader = selectTokenHeader;
module.exports.defer = defer;
