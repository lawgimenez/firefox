/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* This is a JavaScript module to be imported via
   ChromeUtils.importESModule() and acts as a singleton. Only the following
   listed symbols will exposed on import, and only when and where imported.
  */

import { Logger } from "resource://tps/logger.sys.mjs";

import { FormHistory } from "resource://gre/modules/FormHistory.sys.mjs";

/**
 * FormDB
 *
 * Helper object containing methods to interact with the FormHistory module.
 */
var FormDB = {
  async _update(data) {
    await FormHistory.update(data);
  },

  /**
   * insertValue
   *
   * Adds the specified value for the specified fieldname into form history.
   *
   * @param fieldname The form fieldname to insert
   * @param value The form value to insert
   * @param us The time, in microseconds, to use for the lastUsed
   *        and firstUsed columns
   * @return Promise<undefined>
   */
  insertValue(fieldname, value, us) {
    let data = {
      op: "add",
      fieldname,
      value,
      timesUsed: 1,
      firstUsed: us,
      lastUsed: us,
    };
    return this._update(data);
  },

  /**
   * updateValue
   *
   * Updates a row in the moz_formhistory table with a new value.
   *
   * @param id The id of the row to update
   * @param newvalue The new value to set
   * @return Promise<undefined>
   */
  updateValue(id, newvalue) {
    return this._update({ op: "update", guid: id, value: newvalue });
  },

  /**
   * getDataForValue
   *
   * Retrieves a set of values for a row in the database that
   * corresponds to the given fieldname and value.
   *
   * @param fieldname The fieldname of the row to query
   * @param value The value of the row to query
   * @return Promise<null if no row is found with the specified fieldname and value,
   *         or an object containing the row's guid, lastUsed, and firstUsed
   *         values>
   */
  async getDataForValue(fieldname, value) {
    let results = await FormHistory.search(["guid", "lastUsed", "firstUsed"], {
      fieldname,
      value,
    });
    if (results.length > 1) {
      throw new Error("more than 1 result for this query");
    }
    return results;
  },

  /**
   * remove
   *
   * Removes the specified GUID from the database.
   *
   * @param guid The guid of the item to delete
   * @return Promise<>
   */
  remove(guid) {
    return this._update({ op: "remove", guid });
  },
};

/**
 * FormData class constructor
 *
 * Initializes instance properties.
 */
export function FormData(props, msSinceEpoch) {
  this.fieldname = null;
  this.value = null;
  this.date = 0;
  this.newvalue = null;
  this.usSinceEpoch = msSinceEpoch * 1000;

  for (var prop in props) {
    if (prop in this) {
      this[prop] = props[prop];
    }
  }
}

/**
 * FormData instance methods
 */
FormData.prototype = {
  /**
   * hours_to_us
   *
   * Converts hours since present to microseconds since epoch.
   *
   * @param hours The number of hours since the present time (e.g., 0 is
   *        'now', and -1 is 1 hour ago)
   * @return the corresponding number of microseconds since the epoch
   */
  hours_to_us(hours) {
    return this.usSinceEpoch + hours * 60 * 60 * 1000 * 1000;
  },

  /**
   * Create
   *
   * If this FormData object doesn't exist in the moz_formhistory database,
   * add it.  Throws on error.
   *
   * @return nothing
   */
  Create() {
    Logger.AssertTrue(
      this.fieldname != null && this.value != null,
      "Must specify both fieldname and value"
    );

    return FormDB.getDataForValue(this.fieldname, this.value).then(formdata => {
      if (!formdata) {
        // this item doesn't exist yet in the db, so we need to insert it
        return FormDB.insertValue(
          this.fieldname,
          this.value,
          this.hours_to_us(this.date)
        );
      }
      /* Right now, we ignore this case.  If bug 552531 is ever fixed,
         we might need to add code here to update the firstUsed or
         lastUsed fields, as appropriate.
       */
      return null;
    });
  },

  /**
   * Find
   *
   * Attempts to locate an entry in the moz_formhistory database that
   * matches the fieldname and value for this FormData object.
   *
   * @return true if this entry exists in the database, otherwise false
   */
  Find() {
    return FormDB.getDataForValue(this.fieldname, this.value).then(formdata => {
      let status = formdata != null;
      if (status) {
        /*
        //form history dates currently not synced!  bug 552531
        let us = this.hours_to_us(this.date);
        status = Logger.AssertTrue(
          us >= formdata.firstUsed && us <= formdata.lastUsed,
          "No match for with that date value");

        if (status)
        */
        this.id = formdata.guid;
      }
      return status;
    });
  },

  /**
   * Remove
   *
   * Removes the row represented by this FormData instance from the
   * moz_formhistory database.
   *
   * @return nothing
   */
  async Remove() {
    const formdata = await FormDB.getDataForValue(this.fieldname, this.value);
    if (!formdata) {
      return;
    }
    await FormDB.remove(formdata.guid);
  },
};
