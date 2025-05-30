/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { CryptoUtils } from "resource://services-crypto/utils.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

import { FxAccountsStorageManager } from "resource://gre/modules/FxAccountsStorage.sys.mjs";

import {
  ATTACHED_CLIENTS_CACHE_DURATION,
  ERRNO_INVALID_AUTH_TOKEN,
  ERROR_AUTH_ERROR,
  ERROR_INVALID_PARAMETER,
  ERROR_NO_ACCOUNT,
  ERROR_TO_GENERAL_ERROR_CLASS,
  ERROR_UNKNOWN,
  ERROR_UNVERIFIED_ACCOUNT,
  FXA_PWDMGR_PLAINTEXT_FIELDS,
  FXA_PWDMGR_REAUTH_ALLOWLIST,
  FXA_PWDMGR_SECURE_FIELDS,
  OAUTH_CLIENT_ID,
  ON_ACCOUNT_STATE_CHANGE_NOTIFICATION,
  ONLOGIN_NOTIFICATION,
  ONLOGOUT_NOTIFICATION,
  ON_PRELOGOUT_NOTIFICATION,
  ONVERIFIED_NOTIFICATION,
  ON_DEVICE_DISCONNECTED_NOTIFICATION,
  POLL_SESSION,
  PREF_ACCOUNT_ROOT,
  PREF_LAST_FXA_USER,
  SERVER_ERRNO_TO_ERROR,
  log,
  logPII,
  logManager,
} from "resource://gre/modules/FxAccountsCommon.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  FxAccountsClient: "resource://gre/modules/FxAccountsClient.sys.mjs",
  FxAccountsCommands: "resource://gre/modules/FxAccountsCommands.sys.mjs",
  FxAccountsConfig: "resource://gre/modules/FxAccountsConfig.sys.mjs",
  FxAccountsDevice: "resource://gre/modules/FxAccountsDevice.sys.mjs",
  FxAccountsKeys: "resource://gre/modules/FxAccountsKeys.sys.mjs",
  FxAccountsOAuth: "resource://gre/modules/FxAccountsOAuth.sys.mjs",
  FxAccountsProfile: "resource://gre/modules/FxAccountsProfile.sys.mjs",
  FxAccountsTelemetry: "resource://gre/modules/FxAccountsTelemetry.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "mpLocked", () => {
  return ChromeUtils.importESModule("resource://services-sync/util.sys.mjs")
    .Utils.mpLocked;
});

ChromeUtils.defineLazyGetter(lazy, "ensureMPUnlocked", () => {
  return ChromeUtils.importESModule("resource://services-sync/util.sys.mjs")
    .Utils.ensureMPUnlocked;
});

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "FXA_ENABLED",
  "identity.fxaccounts.enabled",
  true
);

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "oauthEnabled",
  "identity.fxaccounts.oauth.enabled",
  true
);

export const ERROR_INVALID_ACCOUNT_STATE = "ERROR_INVALID_ACCOUNT_STATE";

// An AccountState object holds all state related to one specific account.
// It is considered "private" to the FxAccounts modules.
// Only one AccountState is ever "current" in the FxAccountsInternal object -
// whenever a user logs out or logs in, the current AccountState is discarded,
// making it impossible for the wrong state or state data to be accidentally
// used.
// In addition, it has some promise-related helpers to ensure that if an
// attempt is made to resolve a promise on a "stale" state (eg, if an
// operation starts, but a different user logs in before the operation
// completes), the promise will be rejected.
// It is intended to be used thusly:
// somePromiseBasedFunction: function() {
//   let currentState = this.currentAccountState;
//   return someOtherPromiseFunction().then(
//     data => currentState.resolve(data)
//   );
// }
// If the state has changed between the function being called and the promise
// being resolved, the .resolve() call will actually be rejected.
export function AccountState(storageManager) {
  this.storageManager = storageManager;
  this.inFlightTokenRequests = new Map();
  this.promiseInitialized = this.storageManager
    .getAccountData()
    .then(data => {
      this.oauthTokens = data && data.oauthTokens ? data.oauthTokens : {};
    })
    .catch(err => {
      log.error("Failed to initialize the storage manager", err);
      // Things are going to fall apart, but not much we can do about it here.
    });
}

AccountState.prototype = {
  oauthTokens: null,
  whenVerifiedDeferred: null,
  whenKeysReadyDeferred: null,

  // If the storage manager has been nuked then we are no longer current.
  get isCurrent() {
    return this.storageManager != null;
  },

  abort() {
    if (this.whenVerifiedDeferred) {
      this.whenVerifiedDeferred.reject(
        new Error("Verification aborted; Another user signing in")
      );
      this.whenVerifiedDeferred = null;
    }
    if (this.whenKeysReadyDeferred) {
      this.whenKeysReadyDeferred.reject(
        new Error("Key fetching aborted; Another user signing in")
      );
      this.whenKeysReadyDeferred = null;
    }
    this.inFlightTokenRequests.clear();
    return this.signOut();
  },

  // Clobber all cached data and write that empty data to storage.
  async signOut() {
    this.cert = null;
    this.keyPair = null;
    this.oauthTokens = null;
    this.inFlightTokenRequests.clear();

    // Avoid finalizing the storageManager multiple times (ie, .signOut()
    // followed by .abort())
    if (!this.storageManager) {
      return;
    }
    const storageManager = this.storageManager;
    this.storageManager = null;

    await storageManager.deleteAccountData();
    await storageManager.finalize();
  },

  // Get user account data. Optionally specify explicit field names to fetch
  // (and note that if you require an in-memory field you *must* specify the
  // field name(s).)
  getUserAccountData(fieldNames = null) {
    if (!this.isCurrent) {
      return Promise.reject(new Error("Another user has signed in"));
    }
    return this.storageManager.getAccountData(fieldNames).then(result => {
      return this.resolve(result);
    });
  },

  async updateUserAccountData(updatedFields) {
    if ("uid" in updatedFields) {
      const existing = await this.getUserAccountData(["uid"]);
      if (existing.uid != updatedFields.uid) {
        throw new Error(
          "The specified credentials aren't for the current user"
        );
      }
      // We need to nuke uid as storage will complain if we try and
      // update it (even when the value is the same)
      updatedFields = Cu.cloneInto(updatedFields, {}); // clone it first
      delete updatedFields.uid;
    }
    if (!this.isCurrent) {
      return Promise.reject(new Error(ERROR_INVALID_ACCOUNT_STATE));
    }
    return this.storageManager.updateAccountData(updatedFields);
  },

  resolve(result) {
    if (!this.isCurrent) {
      log.info(
        "An accountState promise was resolved, but was actually rejected" +
          " due to the account state changing. This can happen if a new account signed in, or" +
          " the account was signed out. Originally resolved with, ",
        result
      );
      return Promise.reject(new Error(ERROR_INVALID_ACCOUNT_STATE));
    }
    return Promise.resolve(result);
  },

  reject(error) {
    // It could be argued that we should just let it reject with the original
    // error - but this runs the risk of the error being (eg) a 401, which
    // might cause the consumer to attempt some remediation and cause other
    // problems.
    if (!this.isCurrent) {
      log.info(
        "An accountState promise was rejected, but we are ignoring that" +
          " reason and rejecting it due to the account state changing. This can happen if" +
          " a different account signed in or the account was signed out" +
          " originally resolved with, ",
        error
      );
      return Promise.reject(new Error(ERROR_INVALID_ACCOUNT_STATE));
    }
    return Promise.reject(error);
  },

  // Abstractions for storage of cached tokens - these are all sync, and don't
  // handle revocation etc - it's just storage (and the storage itself is async,
  // but we don't return the storage promises, so it *looks* sync)
  // These functions are sync simply so we can handle "token races" - when there
  // are multiple in-flight requests for the same scope, we can detect this
  // and revoke the redundant token.

  // A preamble for the cache helpers...
  _cachePreamble() {
    if (!this.isCurrent) {
      throw new Error(ERROR_INVALID_ACCOUNT_STATE);
    }
  },

  // Set a cached token. |tokenData| must have a 'token' element, but may also
  // have additional fields.
  // The 'get' functions below return the entire |tokenData| value.
  setCachedToken(scopeArray, tokenData) {
    this._cachePreamble();
    if (!tokenData.token) {
      throw new Error("No token");
    }
    let key = getScopeKey(scopeArray);
    this.oauthTokens[key] = tokenData;
    // And a background save...
    this._persistCachedTokens();
  },

  // Return data for a cached token or null (or throws on bad state etc)
  getCachedToken(scopeArray) {
    this._cachePreamble();
    let key = getScopeKey(scopeArray);
    let result = this.oauthTokens[key];
    if (result) {
      // later we might want to check an expiry date - but we currently
      // have no such concept, so just return it.
      log.trace("getCachedToken returning cached token");
      return result;
    }
    return null;
  },

  // Remove a cached token from the cache.  Does *not* revoke it from anywhere.
  // Returns the entire token entry if found, null otherwise.
  removeCachedToken(token) {
    this._cachePreamble();
    let data = this.oauthTokens;
    for (let [key, tokenValue] of Object.entries(data)) {
      if (tokenValue.token == token) {
        delete data[key];
        // And a background save...
        this._persistCachedTokens();
        return tokenValue;
      }
    }
    return null;
  },

  // A hook-point for tests.  Returns a promise that's ignored in most cases
  // (notable exceptions are tests and when we explicitly are saving the entire
  // set of user data.)
  _persistCachedTokens() {
    this._cachePreamble();
    return this.updateUserAccountData({ oauthTokens: this.oauthTokens }).catch(
      err => {
        log.error("Failed to update cached tokens", err);
      }
    );
  },
};

/* Given an array of scopes, make a string key by normalizing. */
function getScopeKey(scopeArray) {
  let normalizedScopes = scopeArray.map(item => item.toLowerCase());
  return normalizedScopes.sort().join("|");
}

function getPropertyDescriptor(obj, prop) {
  return (
    Object.getOwnPropertyDescriptor(obj, prop) ||
    getPropertyDescriptor(Object.getPrototypeOf(obj), prop)
  );
}

/**
 * Copies properties from a given object to another object.
 *
 * @param from (object)
 *        The object we read property descriptors from.
 * @param to (object)
 *        The object that we set property descriptors on.
 * @param thisObj (object)
 *        The object that will be used to .bind() all function properties we find to.
 * @param keys ([...])
 *        The names of all properties to be copied.
 */
function copyObjectProperties(from, to, thisObj, keys) {
  for (let prop of keys) {
    // Look for the prop in the prototype chain.
    let desc = getPropertyDescriptor(from, prop);

    if (typeof desc.value == "function") {
      desc.value = desc.value.bind(thisObj);
    }

    if (desc.get) {
      desc.get = desc.get.bind(thisObj);
    }

    if (desc.set) {
      desc.set = desc.set.bind(thisObj);
    }

    Object.defineProperty(to, prop, desc);
  }
}

/**
 * The public API.
 *
 * TODO - *all* non-underscore stuff here should have sphinx docstrings so
 * that docs magically appear on https://firefox-source-docs.mozilla.org/
 * (although |./mach doc| is broken on windows (bug 1232403) and on Linux for
 * markh (some obscure npm issue he gave up on) - so later...)
 */
export class FxAccounts {
  constructor(mocks = null) {
    this._internal = new FxAccountsInternal();
    if (mocks) {
      // it's slightly unfortunate that we need to mock the main "internal" object
      // before calling initialize, primarily so a mock `newAccountState` is in
      // place before initialize calls it, but we need to initialize the
      // "sub-object" mocks after. This can probably be fixed, but whatever...
      copyObjectProperties(
        mocks,
        this._internal,
        this._internal,
        Object.keys(mocks).filter(key => !["device", "commands"].includes(key))
      );
    }
    this._internal.initialize();
    // allow mocking our "sub-objects" too.
    if (mocks) {
      for (let subobject of [
        "currentAccountState",
        "keys",
        "fxaPushService",
        "device",
        "commands",
      ]) {
        if (typeof mocks[subobject] == "object") {
          copyObjectProperties(
            mocks[subobject],
            this._internal[subobject],
            this._internal[subobject],
            Object.keys(mocks[subobject])
          );
        }
      }
    }
  }

  get commands() {
    return this._internal.commands;
  }

  static get config() {
    return lazy.FxAccountsConfig;
  }

  get device() {
    return this._internal.device;
  }

  get keys() {
    return this._internal.keys;
  }

  get telemetry() {
    return this._internal.telemetry;
  }

  _withCurrentAccountState(func) {
    return this._internal.withCurrentAccountState(func);
  }

  _withVerifiedAccountState(func) {
    return this._internal.withVerifiedAccountState(func);
  }

  _withSessionToken(func, mustBeVerified = true) {
    return this._internal.withSessionToken(func, mustBeVerified);
  }

  /**
   * Returns an array listing all the OAuth clients connected to the
   * authenticated user's account. This includes browsers and web sessions - no
   * filtering is done of the set returned by the FxA server. This is using a cached
   * result if it's not older than 4 hours. If the cached data is too old or
   * missing, it fetches new data and updates the cache.
   *
   * @typedef {Object} AttachedClient
   * @property {String} id - OAuth `client_id` of the client.
   * @property {Number} lastAccessedDaysAgo - How many days ago the client last
   *    accessed the FxA server APIs.
   *
   * @returns {Array.<AttachedClient>} A list of attached clients.
   */
  async listAttachedOAuthClients(forceRefresh = false) {
    const now = Date.now();

    // Check if cached data is still valid
    if (
      this._cachedClients &&
      now - this._cachedClientsTimestamp < ATTACHED_CLIENTS_CACHE_DURATION &&
      !forceRefresh
    ) {
      return this._cachedClients;
    }

    // Cache is empty or expired, fetch new data
    let clients = null;
    try {
      clients = await this._fetchAttachedOAuthClients();
      this._cachedClients = clients;
      this._cachedClientsTimestamp = now;
    } catch (error) {
      log.error("Could not update attached clients list ", error);
      clients = [];
    }

    return clients;
  }

  /**
   * This private method actually fetches the clients from the server.
   * It should not be called directly by consumers of this API.
   * @returns {Array.<AttachedClient>}
   * @private
   */
  async _fetchAttachedOAuthClients() {
    const ONE_DAY = 24 * 60 * 60 * 1000;

    return this._withSessionToken(async sessionToken => {
      const response =
        await this._internal.fxAccountsClient.attachedClients(sessionToken);
      const attachedClients = response.body;
      const timestamp = response.headers["x-timestamp"];
      const now =
        timestamp !== undefined
          ? new Date(parseInt(timestamp, 10))
          : Date.now();
      return attachedClients.map(client => {
        const daysAgo = client.lastAccessTime
          ? Math.max(Math.floor((now - client.lastAccessTime) / ONE_DAY), 0)
          : null;
        return {
          id: client.clientId,
          lastAccessedDaysAgo: daysAgo,
        };
      });
    });
  }

  /**
   * Get an OAuth token for the user.
   *
   * @param options
   *        {
   *          scope: (string/array) the oauth scope(s) being requested. As a
   *                 convenience, you may pass a string if only one scope is
   *                 required, or an array of strings if multiple are needed.
   *          ttl: (number) OAuth token TTL in seconds.
   *        }
   *
   * @return Promise.<string | Error>
   *        The promise resolves the oauth token as a string or rejects with
   *        an error object ({error: ERROR, details: {}}) of the following:
   *          INVALID_PARAMETER
   *          NO_ACCOUNT
   *          UNVERIFIED_ACCOUNT
   *          NETWORK_ERROR
   *          AUTH_ERROR
   *          UNKNOWN_ERROR
   */
  async getOAuthToken(options = {}) {
    try {
      return await this._internal.getOAuthToken(options);
    } catch (err) {
      throw this._internal._errorToErrorClass(err);
    }
  }

  /** Gets both the OAuth token and the users scoped keys for that token
   * and verifies that both operations were done for the same user,
   * preventing race conditions where a caller
   * can get the key for one user, and the id of another if the user
   * is rapidly switching between accounts
   *
   * @param options
   *        {
   *          scope: string the oauth scope being requested. This must
   *          be a scope with an associated key, otherwise an error
   *          will be thrown that the key is not available.
   *          ttl: (number) OAuth token TTL in seconds
   *        }
   *
   * @return Promise.<Object | Error>
   * The promise resolve to both the access token being requested, and the scoped key
   *        {
   *         token: (string) access token
   *         key: (object) the scoped key object
   *        }
   * The promise can reject, with one of the errors `getOAuthToken`, `FxAccountKeys.getKeyForScope`, or
   * error if the user changed in-between operations
   */
  getOAuthTokenAndKey(options = {}) {
    return this._withCurrentAccountState(async () => {
      const key = await this.keys.getKeyForScope(options.scope);
      const token = await this.getOAuthToken(options);
      return { token, key };
    });
  }

  /**
   * Remove an OAuth token from the token cache. Callers should call this
   * after they determine a token is invalid, so a new token will be fetched
   * on the next call to getOAuthToken().
   *
   * @param options
   *        {
   *          token: (string) A previously fetched token.
   *        }
   * @return Promise.<undefined> This function will always resolve, even if
   *         an unknown token is passed.
   */
  removeCachedOAuthToken(options) {
    return this._internal.removeCachedOAuthToken(options);
  }

  /**
   * Get details about the user currently signed in to Firefox Accounts.
   *
   * @return Promise
   *        The promise resolves to the credentials object of the signed-in user:
   *        {
   *          email: String: The user's email address
   *          uid: String: The user's unique id
   *          verified: Boolean: Firefox verification status. If false, the account should
   *                    be considered partially logged-in to this Firefox. This may be false
   *                    even if the underying account verfied status is true.
   *          displayName: String or null if not known.
   *          avatar: URL of the avatar for the user. May be the default
   *                  avatar, or null in edge-cases (eg, if there's an account
   *                  issue, etc
   *          avatarDefault: boolean - whether `avatar` is specific to the user
   *                         or the default avatar.
   *        }
   *
   *        or null if no user is signed in. This function never fails except
   *        in pathological cases (eg, file-system errors, etc)
   */
  getSignedInUser(addnFields = []) {
    // Note we don't return the session token, but use it to see if we
    // should fetch the profile. Ditto scopedKeys re verified.
    const ACCT_DATA_FIELDS = [
      "email",
      "uid",
      "verified",
      "scopedKeys",
      "sessionToken",
    ];
    const PROFILE_FIELDS = ["displayName", "avatar", "avatarDefault"];
    return this._withCurrentAccountState(async currentState => {
      const data = await currentState.getUserAccountData(
        ACCT_DATA_FIELDS.concat(addnFields)
      );
      if (!data) {
        return null;
      }
      if (!lazy.FXA_ENABLED) {
        await this.signOut();
        return null;
      }
      if (lazy.oauthEnabled) {
        // data.verified is the sessionToken status. oauth cares only about whether it has the keys.
        // (Note that this never forces `.verified` to `true` even if we *do* have the keys, which
        // seems slightly odd)
        // Note that is the primary-password is locked we can't get the scopedKeys even if they exist, so
        // we don't want to pretend the user is unverified in that case.
        if (Services.logins.isLoggedIn && !data.scopedKeys) {
          data.verified = false;
        }
      } else if (!data.verified) {
        // If the email is not verified, start polling for verification,
        // but return null right away.  We don't want to return a promise
        // that might not be fulfilled for a long time.
        this._internal.startVerifiedCheck(data);
      }
      delete data.scopedKeys;

      let profileData = null;
      if (data.sessionToken) {
        delete data.sessionToken;
        try {
          profileData = await this._internal.profile.getProfile();
        } catch (error) {
          log.error("Could not retrieve profile data", error);
        }
      }
      for (let field of PROFILE_FIELDS) {
        data[field] = profileData ? profileData[field] : null;
      }
      // and email is a special case - if we have profile data we prefer the
      // email from that, as the email we stored for the account itself might
      // not have been updated if the email changed since the user signed in.
      if (profileData && profileData.email) {
        data.email = profileData.email;
      }
      return data;
    });
  }

  /**
   * Checks the status of the account. Resolves with Promise<boolean>, where
   * true indicates the account status is OK and false indicates there's some
   * issue with the account - either that there's no user currently signed in,
   * the entire account has been deleted (in which case there will be no user
   * signed in after this call returns), or that the user must reauthenticate (in
   * which case `this.hasLocalSession()` will return `false` after this call
   * returns).
   *
   * Typically used when some external code which uses, for example, oauth tokens
   * received a 401 error using the token, or that this external code has some
   * other reason to believe the account status may be bad. Note that this will
   * be called automatically in many cases - for example, if calls to fetch the
   * profile, or fetch keys, etc return a 401, there's no need to call this
   * function.
   *
   * Because this hits the server, you should only call this method when you have
   * good reason to believe the session very recently became invalid (eg, because
   * you saw an auth related exception from a remote service.)
   */
  checkAccountStatus() {
    // Note that we don't use _withCurrentAccountState here because that will
    // cause an exception to be thrown if we end up signing out due to the
    // account not existing, which isn't what we want here.
    let state = this._internal.currentAccountState;
    return this._internal.checkAccountStatus(state);
  }

  /**
   * Checks if we have a valid local session state for the current account.
   *
   * @return Promise
   *        Resolves with a boolean, with true indicating that we appear to
   *        have a valid local session, or false if we need to reauthenticate
   *        with the content server to obtain one.
   *        Note that this only checks local state, although typically that's
   *        OK, because we drop the local session information whenever we detect
   *        we are in this state. However, see checkAccountStatus() for a way to
   *        check the account and session status with the server, which can be
   *        considered the canonical, albiet expensive, way to determine the
   *        status of the account.
   */
  hasLocalSession() {
    return this._withCurrentAccountState(async state => {
      let data = await state.getUserAccountData(["sessionToken"]);
      return !!(data && data.sessionToken);
    });
  }

  /** Returns a promise that resolves to true if we can currently connect (ie,
   *  sign in, or re-connect after a password change) to a Firefox Account.
   *  If this returns false, the caller can assume that some UI was shown
   *  which tells the user why we could not connect.
   *
   *  Currently, the primary password being locked is the only reason why
   *  this returns false, and in this scenario, the primary password unlock
   *  dialog will have been shown.
   *
   *  This currently doesn't need to return a promise, but does so that
   *  future enhancements, such as other explanatory UI which requires
   *  async can work without modification of the call-sites.
   */
  static canConnectAccount() {
    return Promise.resolve(!lazy.mpLocked() || lazy.ensureMPUnlocked());
  }

  /**
   * Send a message to a set of devices in the same account
   *
   * @param deviceIds: (null/string/array) The device IDs to send the message to.
   *                   If null, will be sent to all devices.
   *
   * @param excludedIds: (null/string/array) If deviceIds is null, this may
   *                     list device IDs which should not receive the message.
   *
   * @param payload: (object) The payload, which will be JSON.stringified.
   *
   * @param TTL: How long the message should be retained before it is discarded.
   */
  // XXX - used only by sync to tell other devices that the clients collection
  // has changed so they should sync asap. The API here is somewhat vague (ie,
  // "an object"), but to be useful across devices, the payload really needs
  // formalizing. We should try and do something better here.
  notifyDevices(deviceIds, excludedIds, payload, TTL) {
    return this._internal.notifyDevices(deviceIds, excludedIds, payload, TTL);
  }

  /**
   * Resend the verification email for the currently signed-in user.
   *
   */
  resendVerificationEmail() {
    return this._withSessionToken((token, currentState) => {
      this._internal.startPollEmailStatus(currentState, token, "start");
      return this._internal.fxAccountsClient.resendVerificationEmail(token);
    }, false);
  }

  async signOut(localOnly) {
    // Note that we do not use _withCurrentAccountState here, otherwise we
    // end up with an exception due to the user signing out before the call is
    // complete - but that's the entire point of this method :)
    return this._internal.signOut(localOnly);
  }

  // XXX - we should consider killing this - the only reason it is public is
  // so that sync can change it when it notices the device name being changed,
  // and that could probably be replaced with a pref observer.
  updateDeviceRegistration() {
    return this._withCurrentAccountState(_ => {
      return this._internal.updateDeviceRegistration();
    });
  }

  // we should try and kill this too.
  whenVerified(data) {
    return this._withCurrentAccountState(_ => {
      return this._internal.whenVerified(data);
    });
  }

  /**
   * Generate a log file for the FxA action that just completed
   * and refresh the input & output streams.
   */
  async flushLogFile() {
    const logType = await logManager.resetFileLog();
    if (logType == logManager.ERROR_LOG_WRITTEN) {
      console.error(
        "FxA encountered an error - see about:sync-log for the log file."
      );
    }
    Services.obs.notifyObservers(null, "service:log-manager:flush-log-file");
  }
}

var FxAccountsInternal = function () {};

/**
 * The internal API's prototype.
 */
FxAccountsInternal.prototype = {
  // Make a local copy of this constant so we can mock it in testing
  POLL_SESSION,

  // The timeout (in ms) we use to poll for a verified mail for the first
  // VERIFICATION_POLL_START_SLOWDOWN_THRESHOLD minutes if the user has
  // logged-in in this session.
  VERIFICATION_POLL_TIMEOUT_INITIAL: 60000, // 1 minute.
  // All the other cases (> 5 min, on restart etc).
  VERIFICATION_POLL_TIMEOUT_SUBSEQUENT: 5 * 60000, // 5 minutes.
  // After X minutes, the polling will slow down to _SUBSEQUENT if we have
  // logged-in in this session.
  VERIFICATION_POLL_START_SLOWDOWN_THRESHOLD: 5,

  _fxAccountsClient: null,

  // All significant initialization should be done in this initialize() method
  // to help with our mocking story.
  initialize() {
    ChromeUtils.defineLazyGetter(this, "fxaPushService", function () {
      return Cc["@mozilla.org/fxaccounts/push;1"].getService(Ci.nsISupports)
        .wrappedJSObject;
    });

    this.keys = new lazy.FxAccountsKeys(this);

    if (!this.observerPreloads) {
      // A registry of promise-returning functions that `notifyObservers` should
      // call before sending notifications. Primarily used so parts of Firefox
      // which have yet to load for performance reasons can be force-loaded, and
      // thus not miss notifications.
      this.observerPreloads = [
        // Sync
        () => {
          let { Weave } = ChromeUtils.importESModule(
            "resource://services-sync/main.sys.mjs"
          );
          return Weave.Service.promiseInitialized;
        },
      ];
    }

    this.currentTimer = null;
    // This holds the list of attached clients from the /account/attached_clients endpoint
    // Most calls to that endpoint generally don't need fresh data so we try to prevent
    // as many network requests as possible
    this._cachedAttachedClients = null;
    this._cachedAttachedClientsTimestamp = 0;
    // This object holds details about, and storage for, the current user. It
    // is replaced when a different user signs in. Instead of using it directly,
    // you should try and use `withCurrentAccountState`.
    this.currentAccountState = this.newAccountState();
  },

  async withCurrentAccountState(func) {
    const state = this.currentAccountState;
    let result;
    try {
      result = await func(state);
    } catch (ex) {
      return state.reject(ex);
    }
    return state.resolve(result);
  },

  async withVerifiedAccountState(func) {
    return this.withCurrentAccountState(async state => {
      let data = await state.getUserAccountData();
      if (!data) {
        // No signed-in user
        throw this._error(ERROR_NO_ACCOUNT);
      }

      if (!data.verified) {
        // Signed-in user has not verified email
        throw this._error(ERROR_UNVERIFIED_ACCOUNT);
      }
      return func(state);
    });
  },

  async withSessionToken(func, mustBeVerified = true) {
    const state = this.currentAccountState;
    let data = await state.getUserAccountData();
    if (!data) {
      // No signed-in user
      throw this._error(ERROR_NO_ACCOUNT);
    }

    if (mustBeVerified && !data.verified) {
      // Signed-in user has not verified email
      throw this._error(ERROR_UNVERIFIED_ACCOUNT);
    }

    if (!data.sessionToken) {
      throw this._error(ERROR_AUTH_ERROR, "no session token");
    }
    try {
      // Anyone who needs the session token is going to send it to the server,
      // so there's a chance we'll see an auth related error - so handle that
      // here rather than requiring each caller to remember to.
      let result = await func(data.sessionToken, state);
      return state.resolve(result);
    } catch (err) {
      return this._handleTokenError(err);
    }
  },

  get fxAccountsClient() {
    if (!this._fxAccountsClient) {
      this._fxAccountsClient = new lazy.FxAccountsClient();
    }
    return this._fxAccountsClient;
  },

  // The profile object used to fetch the actual user profile.
  _profile: null,
  get profile() {
    if (!this._profile) {
      let profileServerUrl = Services.urlFormatter.formatURLPref(
        "identity.fxaccounts.remote.profile.uri"
      );
      this._profile = new lazy.FxAccountsProfile({
        fxa: this,
        profileServerUrl,
      });
    }
    return this._profile;
  },

  _commands: null,
  get commands() {
    if (!this._commands) {
      // FxAccountsCommands registers a shutdown blocker and must not be
      // instantiated if shutdown already started.
      if (
        !Services.startup.isInOrBeyondShutdownPhase(
          Ci.nsIAppStartup.SHUTDOWN_PHASE_APPSHUTDOWNCONFIRMED
        )
      ) {
        this._commands = new lazy.FxAccountsCommands(this);
      }
    }
    return this._commands;
  },

  _device: null,
  get device() {
    if (!this._device) {
      this._device = new lazy.FxAccountsDevice(this);
    }
    return this._device;
  },

  _oauth: null,
  get oauth() {
    if (!this._oauth) {
      this._oauth = new lazy.FxAccountsOAuth(this.fxAccountsClient, this.keys);
    }
    return this._oauth;
  },

  _telemetry: null,
  get telemetry() {
    if (!this._telemetry) {
      this._telemetry = new lazy.FxAccountsTelemetry(this);
    }
    return this._telemetry;
  },

  beginOAuthFlow(scopes) {
    return this.oauth.beginOAuthFlow(scopes);
  },

  completeOAuthFlow(sessionToken, code, state) {
    return this.oauth.completeOAuthFlow(sessionToken, code, state);
  },

  setScopedKeys(scopedKeys) {
    return this.keys.setScopedKeys(scopedKeys);
  },

  // A hook-point for tests who may want a mocked AccountState or mocked storage.
  newAccountState(credentials) {
    let storage = new FxAccountsStorageManager();
    storage.initialize(credentials);
    return new AccountState(storage);
  },

  notifyDevices(deviceIds, excludedIds, payload, TTL) {
    if (typeof deviceIds == "string") {
      deviceIds = [deviceIds];
    }
    return this.withSessionToken(sessionToken => {
      return this.fxAccountsClient.notifyDevices(
        sessionToken,
        deviceIds,
        excludedIds,
        payload,
        TTL
      );
    });
  },

  /**
   * Return the current time in milliseconds as an integer.  Allows tests to
   * manipulate the date to simulate token expiration.
   */
  now() {
    return this.fxAccountsClient.now();
  },

  /**
   * Return clock offset in milliseconds, as reported by the fxAccountsClient.
   * This can be overridden for testing.
   *
   * The offset is the number of milliseconds that must be added to the client
   * clock to make it equal to the server clock.  For example, if the client is
   * five minutes ahead of the server, the localtimeOffsetMsec will be -300000.
   */
  get localtimeOffsetMsec() {
    return this.fxAccountsClient.localtimeOffsetMsec;
  },

  /**
   * Ask the server whether the user's email has been verified
   */
  checkEmailStatus: function checkEmailStatus(sessionToken, options = {}) {
    if (!sessionToken) {
      return Promise.reject(
        new Error("checkEmailStatus called without a session token")
      );
    }
    return this.fxAccountsClient
      .recoveryEmailStatus(sessionToken, options)
      .catch(error => this._handleTokenError(error));
  },

  // set() makes sure that polling is happening, if necessary.
  // get() does not wait for verification, and returns an object even if
  // unverified. The caller of get() must check .verified .
  // The "fxaccounts:onverified" event will fire only when the verified
  // state goes from false to true, so callers must register their observer
  // and then call get(). In particular, it will not fire when the account
  // was found to be verified in a previous boot: if our stored state says
  // the account is verified, the event will never fire. So callers must do:
  //   register notification observer (go)
  //   userdata = get()
  //   if (userdata.verified()) {go()}

  /**
   * Set the current user signed in to Firefox Accounts.
   *
   * @param credentials
   *        The credentials object obtained by logging in or creating
   *        an account on the FxA server:
   *        {
   *          authAt: The time (seconds since epoch) that this record was
   *                  authenticated
   *          email: The users email address
   *          keyFetchToken: a keyFetchToken which has not yet been used
   *          sessionToken: Session for the FxA server
   *          uid: The user's unique id
   *          unwrapBKey: used to unwrap kB, derived locally from the
   *                      password (not revealed to the FxA server)
   *          verified: true/false
   *        }
   * @return Promise
   *         The promise resolves to null when the data is saved
   *         successfully and is rejected on error.
   */
  async setSignedInUser(credentials) {
    if (!lazy.FXA_ENABLED) {
      throw new Error("Cannot call setSignedInUser when FxA is disabled.");
    }
    for (const pref of Services.prefs.getChildList(PREF_ACCOUNT_ROOT)) {
      Services.prefs.clearUserPref(pref);
    }
    log.debug("setSignedInUser - aborting any existing flows");
    const signedInUser = await this.currentAccountState.getUserAccountData();
    if (signedInUser) {
      await this._signOutServer(
        signedInUser.sessionToken,
        signedInUser.oauthTokens
      );
    }
    await this.abortExistingFlow();
    const currentAccountState = (this.currentAccountState =
      this.newAccountState(
        Cu.cloneInto(credentials, {}) // Pass a clone of the credentials object.
      ));
    // This promise waits for storage, but not for verification.
    // We're telling the caller that this is durable now (although is that
    // really something we should commit to? Why not let the write happen in
    // the background? Already does for updateAccountData ;)
    await currentAccountState.promiseInitialized;
    // Starting point for polling if new user
    if (!lazy.oauthEnabled && !credentials.verified) {
      this.startVerifiedCheck(credentials);
    }
    await this.notifyObservers(ONLOGIN_NOTIFICATION);
    await this.updateDeviceRegistration();
    return currentAccountState.resolve();
  },

  /**
   * Update account data for the currently signed in user.
   *
   * @param credentials
   *        The credentials object containing the fields to be updated.
   *        This object must contain the |uid| field and it must
   *        match the currently signed in user.
   */
  updateUserAccountData(credentials) {
    log.debug(
      "updateUserAccountData called with fields",
      Object.keys(credentials)
    );
    if (logPII()) {
      log.debug("updateUserAccountData called with data", credentials);
    }
    let currentAccountState = this.currentAccountState;
    return currentAccountState.promiseInitialized.then(() => {
      if (!credentials.uid) {
        throw new Error("The specified credentials have no uid");
      }
      return currentAccountState.updateUserAccountData(credentials);
    });
  },

  /*
   * Reset state such that any previous flow is canceled.
   */
  abortExistingFlow() {
    if (this.currentTimer) {
      log.debug("Polling aborted; Another user signing in");
      clearTimeout(this.currentTimer);
      this.currentTimer = 0;
    }
    if (this._profile) {
      this._profile.tearDown();
      this._profile = null;
    }
    if (this._commands) {
      this._commands = null;
    }
    if (this._device) {
      this._device.reset();
    }
    // We "abort" the accountState and assume our caller is about to throw it
    // away and replace it with a new one.
    return this.currentAccountState.abort();
  },

  async checkVerificationStatus() {
    log.trace("checkVerificationStatus");
    let state = this.currentAccountState;
    let data = await state.getUserAccountData();
    if (!data) {
      log.trace("checkVerificationStatus - no user data");
      return null;
    }

    // Always check the verification status, even if the local state indicates
    // we're already verified. If the user changed their password, the check
    // will fail, and we'll enter the reauth state.
    log.trace("checkVerificationStatus - forcing verification status check");
    return this.startPollEmailStatus(state, data.sessionToken, "push");
  },

  /** Destroyes an OAuth Token by sending a request to the FxA server
   * @param { Object } tokenData: The token's data, with `tokenData.token` being the token itself
   **/
  destroyOAuthToken(tokenData) {
    return this.fxAccountsClient.oauthDestroy(OAUTH_CLIENT_ID, tokenData.token);
  },

  _destroyAllOAuthTokens(tokenInfos) {
    if (!tokenInfos) {
      return Promise.resolve();
    }
    // let's just destroy them all in parallel...
    let promises = [];
    for (let tokenInfo of Object.values(tokenInfos)) {
      promises.push(this.destroyOAuthToken(tokenInfo));
    }
    return Promise.all(promises);
  },

  async signOut(localOnly) {
    let sessionToken;
    let tokensToRevoke;
    const data = await this.currentAccountState.getUserAccountData();
    // Save the sessionToken, tokens before resetting them in _signOutLocal().
    if (data) {
      sessionToken = data.sessionToken;
      tokensToRevoke = data.oauthTokens;
    }
    await this.notifyObservers(ON_PRELOGOUT_NOTIFICATION);
    await this._signOutLocal();
    if (!localOnly) {
      // Do this in the background so *any* slow request won't
      // block the local sign out.
      Services.tm.dispatchToMainThread(async () => {
        await this._signOutServer(sessionToken, tokensToRevoke);
        lazy.FxAccountsConfig.resetConfigURLs();
        this.notifyObservers("testhelper-fxa-signout-complete");
      });
    } else {
      // We want to do this either way -- but if we're signing out remotely we
      // need to wait until we destroy the oauth tokens if we want that to succeed.
      lazy.FxAccountsConfig.resetConfigURLs();
    }
    return this.notifyObservers(ONLOGOUT_NOTIFICATION);
  },

  async _signOutLocal() {
    for (const pref of Services.prefs.getChildList(PREF_ACCOUNT_ROOT)) {
      Services.prefs.clearUserPref(pref);
    }
    await this.currentAccountState.signOut();
    // this "aborts" this.currentAccountState but doesn't make a new one.
    await this.abortExistingFlow();
    this.currentAccountState = this.newAccountState();
    return this.currentAccountState.promiseInitialized;
  },

  async _signOutServer(sessionToken, tokensToRevoke) {
    log.debug("Unsubscribing from FxA push.");
    try {
      await this.fxaPushService.unsubscribe();
    } catch (err) {
      log.error("Could not unsubscribe from push.", err);
    }
    if (sessionToken) {
      log.debug("Destroying session and device.");
      try {
        await this.fxAccountsClient.signOut(sessionToken, { service: "sync" });
      } catch (err) {
        log.error("Error during remote sign out of Firefox Accounts", err);
      }
    } else {
      log.warn("Missing session token; skipping remote sign out");
    }
    log.debug("Destroying all OAuth tokens.");
    try {
      await this._destroyAllOAuthTokens(tokensToRevoke);
    } catch (err) {
      log.error("Error during destruction of oauth tokens during signout", err);
    }
  },

  getUserAccountData(fieldNames = null) {
    return this.currentAccountState.getUserAccountData(fieldNames);
  },

  /**
   * Setup for and if necessary do email verification polling.
   */
  loadAndPoll() {
    let currentState = this.currentAccountState;
    return currentState.getUserAccountData().then(data => {
      if (data) {
        if (!lazy.oauthEnabled) {
          if (!data.verified) {
            this.startPollEmailStatus(
              currentState,
              data.sessionToken,
              "browser-startup"
            );
          }
        }
      }
      return data;
    });
  },

  startVerifiedCheck(data) {
    log.debug("startVerifiedCheck", data && data.verified);
    if (logPII()) {
      log.debug("startVerifiedCheck with user data", data);
    }

    // Get us to the verified state. This returns a promise that will fire when
    // verification is complete.

    // The callers of startVerifiedCheck never consume a returned promise (ie,
    // this is simply kicking off a background fetch) so we must add a rejection
    // handler to avoid runtime warnings about the rejection not being handled.
    this.whenVerified(data).catch(err =>
      log.info("startVerifiedCheck promise was rejected: " + err)
    );
  },

  whenVerified(data) {
    let currentState = this.currentAccountState;
    if (data.verified) {
      log.debug("already verified");
      return currentState.resolve(data);
    }
    if (!currentState.whenVerifiedDeferred) {
      log.debug("whenVerified promise starts polling for verified email");
      this.startPollEmailStatus(currentState, data.sessionToken, "start");
    }
    return currentState.whenVerifiedDeferred.promise.then(result =>
      currentState.resolve(result)
    );
  },

  async notifyObservers(topic, data) {
    for (let f of this.observerPreloads) {
      try {
        await f();
      } catch (O_o) {}
    }
    log.debug("Notifying observers of " + topic);
    Services.obs.notifyObservers(null, topic, data);
  },

  startPollEmailStatus(currentState, sessionToken, why) {
    log.debug("entering startPollEmailStatus: " + why);
    // If we were already polling, stop and start again.  This could happen
    // if the user requested the verification email to be resent while we
    // were already polling for receipt of an earlier email.
    if (this.currentTimer) {
      log.debug(
        "startPollEmailStatus starting while existing timer is running"
      );
      clearTimeout(this.currentTimer);
      this.currentTimer = null;
    }

    this.pollStartDate = Date.now();
    if (!currentState.whenVerifiedDeferred) {
      currentState.whenVerifiedDeferred = Promise.withResolvers();
      // This deferred might not end up with any handlers (eg, if sync
      // is yet to start up.)  This might cause "A promise chain failed to
      // handle a rejection" messages, so add an error handler directly
      // on the promise to log the error.
      currentState.whenVerifiedDeferred.promise.then(
        () => {
          log.info("the user became verified");
          // We are now ready for business. This should only be invoked once
          // per setSignedInUser(), regardless of whether we've rebooted since
          // setSignedInUser() was called.
          this.notifyObservers(ONVERIFIED_NOTIFICATION);
        },
        err => {
          log.info("the wait for user verification was stopped: " + err);
        }
      );
    }
    return this.pollEmailStatus(currentState, sessionToken, why);
  },

  // We return a promise for testing only. Other callers can ignore this,
  // since verification polling continues in the background.
  async pollEmailStatus(currentState, sessionToken, why) {
    log.debug("entering pollEmailStatus: " + why);
    if (lazy.oauthEnabled) {
      log.debug("not polling for verification because oauth is enabled");
      return;
    }
    let nextPollMs;
    try {
      const response = await this.checkEmailStatus(sessionToken, {
        reason: why,
      });
      log.debug("checkEmailStatus -> " + JSON.stringify(response));
      if (response && response.verified) {
        await this.onPollEmailSuccess(currentState);
        return;
      }
    } catch (error) {
      if (error && error.code && error.code == 401) {
        let error = new Error("Verification status check failed");
        this._rejectWhenVerified(currentState, error);
        return;
      }
      if (error && error.retryAfter) {
        // If the server told us to back off, back off the requested amount.
        nextPollMs = (error.retryAfter + 3) * 1000;
        log.warn(
          `the server rejected our email status check and told us to try again in ${nextPollMs}ms`
        );
      } else {
        log.error(`checkEmailStatus failed to poll`, error);
      }
    }
    if (why == "push") {
      return;
    }
    let pollDuration = Date.now() - this.pollStartDate;
    // Polling session expired.
    if (pollDuration >= this.POLL_SESSION) {
      if (currentState.whenVerifiedDeferred) {
        let error = new Error("User email verification timed out.");
        this._rejectWhenVerified(currentState, error);
      }
      log.debug("polling session exceeded, giving up");
      return;
    }
    // Poll email status again after a short delay.
    if (nextPollMs === undefined) {
      let currentMinute = Math.ceil(pollDuration / 60000);
      nextPollMs =
        why == "start" &&
        currentMinute < this.VERIFICATION_POLL_START_SLOWDOWN_THRESHOLD
          ? this.VERIFICATION_POLL_TIMEOUT_INITIAL
          : this.VERIFICATION_POLL_TIMEOUT_SUBSEQUENT;
    }
    this._scheduleNextPollEmailStatus(
      currentState,
      sessionToken,
      nextPollMs,
      why
    );
  },

  // Easy-to-mock testable method
  _scheduleNextPollEmailStatus(currentState, sessionToken, nextPollMs, why) {
    log.debug("polling with timeout = " + nextPollMs);
    this.currentTimer = setTimeout(() => {
      this.pollEmailStatus(currentState, sessionToken, why);
    }, nextPollMs);
  },

  async onPollEmailSuccess(currentState) {
    try {
      await currentState.updateUserAccountData({ verified: true });
      const accountData = await currentState.getUserAccountData();
      this._setLastUserPref(accountData.email);
      if (currentState.whenVerifiedDeferred) {
        currentState.whenVerifiedDeferred.resolve(accountData);
        delete currentState.whenVerifiedDeferred;
      }
    } catch (e) {
      log.error(e);
    }
  },

  _rejectWhenVerified(currentState, error) {
    currentState.whenVerifiedDeferred.reject(error);
    delete currentState.whenVerifiedDeferred;
  },

  /**
   * Does the actual fetch of an oauth token for getOAuthToken()
   * using the account session token.
   *
   * It's split out into a separate method so that we can easily
   * stash in-flight calls in a cache.
   *
   * @param {String} scopeString
   * @param {Number} ttl
   * @returns {Promise<string>}
   * @private
   */
  async _doTokenFetchWithSessionToken(sessionToken, scopeString, ttl) {
    const result = await this.fxAccountsClient.accessTokenWithSessionToken(
      sessionToken,
      OAUTH_CLIENT_ID,
      scopeString,
      ttl
    );
    return result.access_token;
  },

  getOAuthToken(options = {}) {
    log.debug("getOAuthToken enter");
    let scope = options.scope;
    if (typeof scope === "string") {
      scope = [scope];
    }

    if (!scope || !scope.length) {
      return Promise.reject(
        this._error(
          ERROR_INVALID_PARAMETER,
          "Missing or invalid 'scope' option"
        )
      );
    }

    return this.withSessionToken(async (sessionToken, currentState) => {
      // Early exit for a cached token.
      let cached = currentState.getCachedToken(scope);
      if (cached) {
        log.debug("getOAuthToken returning a cached token");
        return cached.token;
      }

      // Build the string we use in our "inflight" map and that we send to the
      // server. Because it's used as a key in the map we sort the scopes.
      let scopeString = scope.sort().join(" ");

      // We keep a map of in-flight requests to avoid multiple promise-based
      // consumers concurrently requesting the same token.
      let maybeInFlight = currentState.inFlightTokenRequests.get(scopeString);
      if (maybeInFlight) {
        log.debug("getOAuthToken has an in-flight request for this scope");
        return maybeInFlight;
      }

      // We need to start a new fetch and stick the promise in our in-flight map
      // and remove it when it resolves.
      let promise = this._doTokenFetchWithSessionToken(
        sessionToken,
        scopeString,
        options.ttl
      )
        .then(token => {
          // As a sanity check, ensure something else hasn't raced getting a token
          // of the same scope. If something has we just make noise rather than
          // taking any concrete action because it should never actually happen.
          if (currentState.getCachedToken(scope)) {
            log.error(`detected a race for oauth token with scope ${scope}`);
          }
          // If we got one, cache it.
          if (token) {
            let entry = { token };
            currentState.setCachedToken(scope, entry);
          }
          return token;
        })
        .finally(() => {
          // Remove ourself from the in-flight map. There's no need to check the
          // result of .delete() to handle a signout race, because setCachedToken
          // above will fail in that case and cause the entire call to fail.
          currentState.inFlightTokenRequests.delete(scopeString);
        });

      currentState.inFlightTokenRequests.set(scopeString, promise);
      return promise;
    });
  },

  /**
   * Remove an OAuth token from the token cache
   * and makes a network request to FxA server to destroy the token.
   *
   * @param options
   *        {
   *          token: (string) A previously fetched token.
   *        }
   * @return Promise.<undefined> This function will always resolve, even if
   *         an unknown token is passed.
   */
  removeCachedOAuthToken(options) {
    if (!options.token || typeof options.token !== "string") {
      throw this._error(
        ERROR_INVALID_PARAMETER,
        "Missing or invalid 'token' option"
      );
    }
    return this.withCurrentAccountState(currentState => {
      let existing = currentState.removeCachedToken(options.token);
      if (existing) {
        // background destroy.
        this.destroyOAuthToken(existing).catch(err => {
          log.warn("FxA failed to revoke a cached token", err);
        });
      }
    });
  },

  /** Sets the user to be verified in the account state,
   * This prevents any polling for the user's verification state from the FxA server
   **/
  async setUserVerified() {
    await this.withCurrentAccountState(async currentState => {
      // TODO: setting `verified` is unnecessary if oauthEnabled - it looks at our key state.
      const userData = await currentState.getUserAccountData();
      if (!userData.verified) {
        await currentState.updateUserAccountData({ verified: true });
      }
    });
    await this.notifyObservers(ONVERIFIED_NOTIFICATION);
  },

  async _getVerifiedAccountOrReject() {
    let data = await this.currentAccountState.getUserAccountData();
    if (!data) {
      // No signed-in user
      throw this._error(ERROR_NO_ACCOUNT);
    }
    if (!data.verified) {
      // Signed-in user has not verified email
      throw this._error(ERROR_UNVERIFIED_ACCOUNT);
    }
    return data;
  },

  // _handle* methods used by push, used when the account/device status is
  // changed on a different device.
  async _handleAccountDestroyed(uid) {
    let state = this.currentAccountState;
    const accountData = await state.getUserAccountData();
    const localUid = accountData ? accountData.uid : null;
    if (!localUid) {
      log.info(
        `Account destroyed push notification received, but we're already logged-out`
      );
      return null;
    }
    if (uid == localUid) {
      const data = JSON.stringify({ isLocalDevice: true });
      await this.notifyObservers(ON_DEVICE_DISCONNECTED_NOTIFICATION, data);
      return this.signOut(true);
    }
    log.info(
      `The destroyed account uid doesn't match with the local uid. ` +
        `Local: ${localUid}, account uid destroyed: ${uid}`
    );
    return null;
  },

  async _handleDeviceDisconnection(deviceId) {
    let state = this.currentAccountState;
    const accountData = await state.getUserAccountData();
    if (!accountData || !accountData.device) {
      // Nothing we can do here.
      return;
    }
    const localDeviceId = accountData.device.id;
    const isLocalDevice = deviceId == localDeviceId;
    if (isLocalDevice) {
      this.signOut(true);
    }
    const data = JSON.stringify({ isLocalDevice });
    await this.notifyObservers(ON_DEVICE_DISCONNECTED_NOTIFICATION, data);
  },

  _setLastUserPref(newEmail) {
    Services.prefs.setStringPref(
      PREF_LAST_FXA_USER,
      CryptoUtils.sha256Base64(newEmail)
    );
  },

  async _handleEmailUpdated(newEmail) {
    this._setLastUserPref(newEmail);
    await this.currentAccountState.updateUserAccountData({ email: newEmail });
  },

  /*
   * Coerce an error into one of the general error cases:
   *          NETWORK_ERROR
   *          AUTH_ERROR
   *          UNKNOWN_ERROR
   *
   * These errors will pass through:
   *          INVALID_PARAMETER
   *          NO_ACCOUNT
   *          UNVERIFIED_ACCOUNT
   */
  _errorToErrorClass(aError) {
    if (aError.errno) {
      let error = SERVER_ERRNO_TO_ERROR[aError.errno];
      return this._error(
        ERROR_TO_GENERAL_ERROR_CLASS[error] || ERROR_UNKNOWN,
        aError
      );
    } else if (
      aError.message &&
      (aError.message === "INVALID_PARAMETER" ||
        aError.message === "NO_ACCOUNT" ||
        aError.message === "UNVERIFIED_ACCOUNT" ||
        aError.message === "AUTH_ERROR")
    ) {
      return aError;
    }
    return this._error(ERROR_UNKNOWN, aError);
  },

  _error(aError, aDetails) {
    log.error("FxA rejecting with error ${aError}, details: ${aDetails}", {
      aError,
      aDetails,
    });
    let reason = new Error(aError);
    if (aDetails) {
      reason.details = aDetails;
    }
    return reason;
  },

  // Attempt to update the auth server with whatever device details are stored
  // in the account data. Returns a promise that always resolves, never rejects.
  // If the promise resolves to a value, that value is the device id.
  updateDeviceRegistration() {
    return this.device.updateDeviceRegistration();
  },

  /**
   * Delete all the persisted credentials we store for FxA. After calling
   * this, the user will be forced to re-authenticate to continue.
   *
   * @return Promise resolves when the user data has been persisted
   */
  dropCredentials(state) {
    // Delete all fields except those required for the user to
    // reauthenticate.
    let updateData = {};
    let clearField = field => {
      if (!FXA_PWDMGR_REAUTH_ALLOWLIST.has(field)) {
        updateData[field] = null;
      }
    };
    FXA_PWDMGR_PLAINTEXT_FIELDS.forEach(clearField);
    FXA_PWDMGR_SECURE_FIELDS.forEach(clearField);

    return state.updateUserAccountData(updateData);
  },

  async checkAccountStatus(state) {
    log.info("checking account status...");
    let data = await state.getUserAccountData(["uid", "sessionToken"]);
    if (!data) {
      log.info("account status: no user");
      return false;
    }
    // If we have a session token, then check if that remains valid - if this
    // works we know the account must also be OK.
    if (data.sessionToken) {
      if (await this.fxAccountsClient.sessionStatus(data.sessionToken)) {
        log.info("account status: ok");
        return true;
      }
    }
    let exists = await this.fxAccountsClient.accountStatus(data.uid);
    if (!exists) {
      // Delete all local account data. Since the account no longer
      // exists, we can skip the remote calls.
      log.info("account status: deleted");
      await this._handleAccountDestroyed(data.uid);
    } else {
      // Note that we may already have been in a "needs reauth" state (ie, if
      // this function was called when we already had no session token), but
      // that's OK - re-notifying etc should cause no harm.
      log.info("account status: needs reauthentication");
      await this.dropCredentials(this.currentAccountState);
      // Notify the account state has changed so the UI updates.
      await this.notifyObservers(ON_ACCOUNT_STATE_CHANGE_NOTIFICATION);
    }
    return false;
  },

  async _handleTokenError(err) {
    if (!err || err.code != 401 || err.errno != ERRNO_INVALID_AUTH_TOKEN) {
      throw err;
    }
    log.warn("handling invalid token error", err);
    // Note that we don't use `withCurrentAccountState` here as that will cause
    // an error to be thrown if we sign out due to the account not existing.
    let state = this.currentAccountState;
    let ok = await this.checkAccountStatus(state);
    if (ok) {
      log.warn("invalid token error, but account state appears ok?");
    }
    // always re-throw the error.
    throw err;
  },
};

let fxAccountsSingleton = null;

export function getFxAccountsSingleton() {
  if (fxAccountsSingleton) {
    return fxAccountsSingleton;
  }

  fxAccountsSingleton = new FxAccounts();

  // XXX Bug 947061 - We need a strategy for resuming email verification after
  // browser restart
  fxAccountsSingleton._internal.loadAndPoll();

  return fxAccountsSingleton;
}

// `AccountState` is exported for tests.
