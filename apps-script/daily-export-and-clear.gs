/**
 * Portugal Bakery: Daily Sheet Export + Clear — v3 (Sunday-proof + changed markers)
 * ------------------------------------------------------------------
 * Every day except Sunday at ~5AM Johannesburg time:
 *   1. Figures out which ONE spreadsheet holds yesterday's orders
 *      (the sheet your app wrote into, per getActiveSheetId() in sheets.ts)
 *   2. Exports that spreadsheet as a full .xlsx into BOTH Drive folders
 *   3. Clears the Quantity (C), added (F:I), Comments (J), and LATE (K)
 *      columns from row 2 down on that sheet
 *
 * Day logic (ALWAYS Johannesburg time, no matter what this script's
 * timezone setting says):
 *   Mon, Tue, Wed -> MON-WED
 *   Thu, Fri, Sat -> THU-SAT
 *   Sun           -> NOTHING (weekend orders stay in MON-WED until Monday 5AM)
 *
 * WHAT CHANGED IN v2 (fixing the Sunday 2AM download):
 *   1. The old day check used new Date().getDay(), which reads the SCRIPT
 *      PROJECT's timezone — not Johannesburg's. New Apps Script projects
 *      default to America/New_York, so "skip Sunday" could fire on the
 *      wrong day, and the 5AM trigger hour was also that timezone's 5AM.
 *      v2 works out the weekday explicitly in Africa/Johannesburg, so the
 *      day logic is correct regardless of the project timezone.
 *   2. The 2AM Sunday run was a LEFTOVER TRIGGER from an older version of
 *      this script (old versions exported the "active" sheet, which maps
 *      Sunday -> MON-WED — exactly what you saw). The old
 *      removeDailyTrigger() only deleted triggers named exactly
 *      "dailyExportAndClear", so old ones survived. v2's
 *      removeAllExportTriggers() wipes every leftover time trigger.
 *
 * WHAT'S NEW IN v3 (changed markers):
 *   Whenever a person edits a row on the "Customer Order Details" tab, the
 *   script stamps the word "changed" in column L and the date/time in
 *   column M. Those columns are protected (only you can edit them), and if
 *   anyone somehow clears them the script puts them straight back — so the
 *   word "changed" cannot be removed by the people editing the sheet.
 *   Run `setupChangedMarkers` once in EACH spreadsheet project to switch
 *   it on (see the CHANGED MARKERS section at the bottom of this file).
 *
 * SETUP (do this in BOTH spreadsheets if you added the script to both):
 *   1. Open the spreadsheet -> Extensions -> Apps Script
 *   2. Select this script file and REPLACE all its content with this file.
 *   3. Project Settings (left sidebar) -> Time zone -> (GMT+02:00)
 *      Africa/Johannesburg  -- important, so 5AM means 5AM SAST.
 *   4. Run `removeAllExportTriggers` once  -> kills the stray 2AM trigger(s).
 *      Check the log — it names every trigger it deleted.
 *   5. Run `createDailyTrigger` once       -> one clean 5AM daily trigger.
 *   6. Run `checkSetup` once               -> verifies timezone + lists what
 *      triggers remain. You should see exactly ONE, named
 *      "dailyExportAndClear".
 *
 * To stop it all later, run `removeAllExportTriggers` again.
 */

const CONFIG = {
  // Both of these get a copy of the export, every time.
  driveFolderIds: [
    '18SLw0KzhORByk2l7srYrQivyk7OVG_ox',
    '1YMd2-2TcEaHpG_Vva7CwoSTlk5GvHJn8'
  ],

  // The two order sheets your app switches between by day.
  spreadsheets: {
    monWed: {
      id: '137ZxSSgodwcOOUpItZyZplMpwn3QXL8DvdneqQowJ98',
      gid: 1049158606,
      label: 'MON-WED'
    },
    thuSat: {
      id: '1PvpM6Be4xOCa_GqMYEg7-9M1BwcT1kfznwOxLRImEAw',
      gid: 1026895194,
      label: 'THU-SAT'
    }
  },

  // What hour the daily trigger fires (Johannesburg time, once the project
  // timezone in step 3 above is set correctly).
  triggerHour: 5
};

// Everything time-related in this script is anchored to the bakery's
// timezone on purpose — see the v2 notes above.
const JHB_TZ = 'Africa/Johannesburg';

/**
 * Today's day-of-week in JOHANNESBURG, as 0=Sun, 1=Mon, ... 6=Sat.
 * Never trusts the script project's timezone setting.
 */
function jhbDayOfWeek() {
  // 'u' formats as ISO day-of-week: 1=Mon ... 7=Sun. 7%7 turns Sunday into 0.
  var iso = parseInt(Utilities.formatDate(new Date(), JHB_TZ, 'u'), 10);
  if (isNaN(iso)) {
    // Extremely defensive fallback: day name, in English.
    var names = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
    var name = Utilities.formatDate(new Date(), JHB_TZ, 'EEEE');
    return names[name] !== undefined ? names[name] : -1;
  }
  return iso % 7;
}

/**
 * Which sheet holds yesterday's orders. The app picks its sheet by looking
 * at tomorrow, so yesterday's orders went to the sheet chosen by TODAY's
 * weekday.
 *
 * Returns null on Sunday (Johannesburg): nothing is exported or cleared,
 * so weekend orders stay in the MON-WED sheet until Monday morning.
 */
function getActiveSheetConfig() {
  var day = jhbDayOfWeek();

  if (day === 0) {
    return null;                         // Sunday: skip
  }
  if (day === 4 || day === 5 || day === 6) {
    return CONFIG.spreadsheets.thuSat;   // Thu, Fri, Sat
  }
  return CONFIG.spreadsheets.monWed;     // Mon, Tue, Wed
}

/**
 * Main entry point. This is what the daily trigger calls.
 */
function dailyExportAndClear() {
  var now = Utilities.formatDate(new Date(), JHB_TZ, 'yyyy-MM-dd HH:mm');
  var day = jhbDayOfWeek();
  Logger.log('Daily export run at ' + now + ' Johannesburg time (weekday=' + day + ', 0=Sunday).');

  if (day === -1) {
    Logger.log('ERROR: could not determine the Johannesburg weekday — skipping to be safe.');
    return;
  }

  var sheetConfig = getActiveSheetConfig();
  if (!sheetConfig) {
    Logger.log('Sunday (Johannesburg): skipping export and clear. Weekend orders stay in MON-WED until Monday.');
    return;
  }
  runExportAndClear(sheetConfig);
}

/**
 * Does the actual work for a given sheet config: export to both Drive
 * folders, then clear the order columns.
 */
function runExportAndClear(sheetConfig) {
  var dateStamp = Utilities.formatDate(new Date(), JHB_TZ, 'yyyy-MM-dd');

  try {
    exportToAllDrives(sheetConfig, dateStamp);
    clearOrderColumns(sheetConfig);
    Logger.log('Done: ' + sheetConfig.label + ' (file stamped ' + dateStamp + ').');
  } catch (err) {
    Logger.log('ERROR processing ' + sheetConfig.label + ': ' + err);
  }
}

/**
 * Exports the ENTIRE spreadsheet (all tabs) as an .xlsx file and saves a
 * copy into every folder listed in CONFIG.driveFolderIds.
 */
function exportToAllDrives(sheetConfig, dateStamp) {
  var url = 'https://docs.google.com/spreadsheets/d/' + sheetConfig.id + '/export?format=xlsx';

  var response = UrlFetchApp.fetch(url, {
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken()
    }
  });

  var blob = response.getBlob().setName(sheetConfig.label + ' - ' + dateStamp + '.xlsx');

  CONFIG.driveFolderIds.forEach(function (folderId) {
    DriveApp.getFolderById(folderId).createFile(blob.copyBlob());
  });
}

/**
 * Clears Quantity (C), the four "added" columns (F:I), Comments (J), the
 * LATE column (K), and the Changed markers + photo link (L:N) from row 2 down on the
 * specified order tab. Row 1 (headers) and columns A, B, D, E (Customer,
 * Product, Driver, Show) are untouched.
 *
 * The markers are cleared too so each day starts clean — but the export
 * runs BEFORE this, so yesterday's "changed" stamps are kept in the saved
 * .xlsx file.
 */
function clearOrderColumns(sheetConfig) {
  var ss = SpreadsheetApp.openById(sheetConfig.id);
  var sheet = ss.getSheetById(sheetConfig.gid);

  if (!sheet) {
    throw new Error('Could not find sheet with gid ' + sheetConfig.gid);
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return; // nothing to clear

  var numRows = lastRow - 1;

  sheet.getRange(2, 3, numRows, 1).clearContent();  // C: Quantity
  sheet.getRange(2, 6, numRows, 4).clearContent();  // F:I: added x4
  sheet.getRange(2, 10, numRows, 1).clearContent(); // J: Comments
  sheet.getRange(2, 11, numRows, 1).clearContent(); // K: LATE
  sheet.getRange(2, 12, numRows, 3).clearContent(); // L:N: Changed markers + photo link
}

// ===================== TRIGGER MANAGEMENT (v2) ======================

/**
 * Lists every trigger in this Apps Script project, with its handler
 * function name. Run this any time you want to see what is scheduled —
 * if something is still downloading on a Sunday, it will show up here.
 */
function listAllTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  if (triggers.length === 0) {
    Logger.log('No triggers in this project.');
    return;
  }
  triggers.forEach(function (t) {
    var type = t.getEventType() === ScriptApp.EventType.CLOCK ? 'TIME-BASED' : String(t.getEventType());
    Logger.log('TRIGGER: handler="' + t.getHandlerFunction() + '" type=' + type);
  });
}

/**
 * Removes EVERY time-based trigger in this Apps Script project, except
 * triggers belonging to the ReSync script (any handler with "resync" in
 * the name is left alone).
 *
 * This is the fix for the stray 2AM Sunday download: old versions of the
 * export script left triggers behind that removeDailyTrigger() could not
 * delete (it only matched the exact name "dailyExportAndClear").
 *
 * NOTE: if you use another scheduled script besides ReSync in this same
 * project, run listAllTriggers() first, note its handler name, and only
 * run this if you're happy for it to be removed too (you can re-create
 * it afterwards).
 */
function removeAllExportTriggers() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var isClock = t.getEventType() === ScriptApp.EventType.CLOCK;
    var name = (t.getHandlerFunction() || '').toLowerCase();
    if (isClock && name.indexOf('resync') === -1) {
      Logger.log('Deleting time-based trigger: "' + t.getHandlerFunction() + '"');
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  Logger.log(removed > 0
    ? 'Deleted ' + removed + ' time-based trigger(s). Run createDailyTrigger to install the single clean 5AM one.'
    : 'No time-based triggers found to delete.');
}

/**
 * Run this ONCE manually to set up the daily trigger. It first wipes any
 * leftover time-based triggers (including old-name ones the previous
 * removeDailyTrigger() missed), then creates exactly one clean trigger.
 */
function createDailyTrigger() {
  removeAllExportTriggers(); // wipe leftovers AND duplicates

  ScriptApp.newTrigger('dailyExportAndClear')
    .timeBased()
    .everyDays(1)
    .atHour(CONFIG.triggerHour)
    .nearMinute(0)
    .create();

  Logger.log('Daily trigger created: runs around ' + CONFIG.triggerHour +
    ':AM Johannesburg time (if the project timezone is set to Africa/Johannesburg). Sundays are skipped by the script itself.');
}

/**
 * Old removal function, kept for compatibility — only deletes triggers
 * named exactly "dailyExportAndClear". Prefer removeAllExportTriggers().
 */
function removeDailyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyExportAndClear') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

// ============================ DIAGNOSTICS ===========================

/**
 * One-stop check: prints the script project's timezone (and warns if it
 * is not Africa/Johannesburg) plus every trigger currently installed.
 * Run this after setup — you want to see timezone = Africa/Johannesburg
 * and exactly ONE time-based trigger: "dailyExportAndClear".
 */
function checkSetup() {
  var tz = Session.getScriptTimeZone();
  if (tz === 'Africa/Johannesburg') {
    Logger.log('Script timezone: ' + tz + ' (correct)');
  } else {
    Logger.log('Script timezone: ' + tz + '  ⚠ WRONG — Extensions → Apps Script → Project Settings → Time zone → Africa/Johannesburg. ' +
      'Until you change it, the trigger hour is ' + tz + ' time (the day logic is still Johannesburg-correct either way).');
  }
  listAllTriggers();
}

// ============================ TEST HELPERS ==========================

/**
 * Run this manually ANY TIME to test with whichever sheet is "active"
 * for today's real Johannesburg weekday. On Sunday nothing runs, so it
 * just logs.
 */
function testRunNow() {
  var sheetConfig = getActiveSheetConfig();
  if (!sheetConfig) {
    Logger.log('Today is Sunday (Johannesburg), so nothing would run. Use testRunSheet("monWed") to force a test.');
    return;
  }
  runExportAndClear(sheetConfig);
}

/**
 * Run this manually to force-test a SPECIFIC sheet regardless of what day
 * it actually is. Pass "monWed" or "thuSat", e.g. testRunSheet('monWed')
 */
function testRunSheet(key) {
  var sheetConfig = CONFIG.spreadsheets[key];
  if (!sheetConfig) {
    Logger.log('Unknown key "' + key + '" - use "monWed" or "thuSat".');
    return;
  }
  runExportAndClear(sheetConfig);
}

// ==================== CHANGED MARKERS (timestamp + "changed") ====================
/**
 * Whenever a person edits a row on the "Customer Order Details" tab, this
 * stamps the word "changed" in column L and the date/time in column M, so
 * you can see at a glance which order lines were touched and when.
 *
 * The two columns are PROTECTED (only you, the sheet owner, can edit them),
 * and if anyone somehow clears them, the edit trigger immediately puts them
 * back — so the word "changed" cannot be removed by the people editing the
 * sheet.
 *
 * The app only reads columns A:K, so these two extra columns don't affect it.
 * The daily export runs BEFORE the morning clear, so the markers are kept in
 * the exported .xlsx; clearOrderColumns() wipes L:M each morning along with
 * the quantities so every day starts clean.
 *
 * SETUP: run `setupChangedMarkers` ONCE in EACH spreadsheet's Apps Script
 * project (the same two projects you installed this file into). It adds the
 * headers, locks the columns, and installs the edit trigger. You'll be asked
 * to authorise once — that's normal. Safe to run again later; it won't
 * duplicate anything.
 */

var CHANGED_COL = 12;      // L: the word "changed"
var CHANGED_AT_COL = 13;   // M: date/time of the change
var DATA_LAST_COL = 11;    // K: last order-data column
var CHANGED_HEADER = 'Changed';
var CHANGED_AT_HEADER = 'Changed At';
var ORDER_TAB_NAME = 'Customer Order Details';

// The two order tabs (same gids as CONFIG.spreadsheets above). The edit
// trigger only stamps edits on these tabs; edits on any other tab (Products
// List, Freezer, Production, archives...) are ignored.
var ORDER_TAB_GIDS = [1049158606, 1026895194];

/**
 * Run ONCE per spreadsheet (in each project's Apps Script editor):
 * adds the headers, protects columns L:M, and installs the onEdit trigger.
 */
function setupChangedMarkers() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(ORDER_TAB_NAME);
  if (!sheet) {
    throw new Error('Could not find the "' + ORDER_TAB_NAME + '" tab in this spreadsheet. Run this in the MON-WED / THU-SAT order sheet project.');
  }

  // Headers (row 1). Written before protecting; re-writing is harmless.
  sheet.getRange(1, CHANGED_COL).setValue(CHANGED_HEADER);
  sheet.getRange(1, CHANGED_AT_COL).setValue(CHANGED_AT_HEADER);

  // Protect L1:M2000 so only the owner can edit it. Reuse an existing
  // protection covering these columns if one is already there.
  var protection = null;
  var existing = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  for (var i = 0; i < existing.length; i++) {
    var r = existing[i].getRange();
    if (r.getRow() === 1 && r.getColumn() === CHANGED_COL && r.getNumColumns() === 2) {
      protection = existing[i];
      break;
    }
  }
  if (!protection) {
    var lastRow = Math.max(2000, sheet.getMaxRows());
    protection = sheet.getRange(1, CHANGED_COL, lastRow, 2).protect();
    protection.setDescription('Auto-filled by the system — please do not delete');
    protection.setWarningOnly(false); // hard block, not just a warning
    var me = Session.getActiveUser().getEmail();
    protection.getEditors().forEach(function (u) {
      if (u.getEmail() !== me) protection.removeEditor(u);
    });
    Logger.log('Protected columns L:M (only the owner can edit them).');
  } else {
    Logger.log('Columns L:M are already protected.');
  }

  // Install the onEdit trigger. It runs as you (the owner), so it can write
  // to the protected columns even when a staff member makes the edit.
  var already = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'markChangedOnEdit';
  });
  if (!already) {
    ScriptApp.newTrigger('markChangedOnEdit')
      .forSpreadsheet(ss)
      .onEdit()
      .create();
    Logger.log('Edit trigger installed: markChangedOnEdit.');
  } else {
    Logger.log('Edit trigger already installed.');
  }

  Logger.log('Done. From now on, any edit to a row on "' + ORDER_TAB_NAME + '" stamps "changed" + the time in L:M.');
}

/**
 * Installable onEdit trigger. Fires whenever a person edits this
 * spreadsheet. If the edit touched the order tab's data columns (A:K) — or
 * the marker columns themselves (someone trying to delete "changed") — every
 * affected row that still has order data gets stamped with "changed" and the
 * current Johannesburg date/time.
 *
 * Programmatic changes (the app writing quantities, the daily clear) do NOT
 * fire this trigger, so only real human edits get stamped.
 */
function markChangedOnEdit(e) {
  if (!e || !e.range) return;
  var sheet = e.range.getSheet();
  if (ORDER_TAB_GIDS.indexOf(sheet.getSheetId()) === -1) return;

  var startRow = e.range.getRow();
  var endRow = startRow + e.range.getNumRows() - 1;
  var startCol = e.range.getColumn();
  var endCol = startCol + e.range.getNumColumns() - 1;

  var touchesData = startCol <= DATA_LAST_COL;
  var touchesMarkers = endCol >= CHANGED_COL && startCol <= CHANGED_AT_COL;
  if (!touchesData && !touchesMarkers) return;

  var firstRow = Math.max(startRow, 2); // never stamp the header row
  if (firstRow > endRow) return;
  var numRows = endRow - firstRow + 1;

  // Which of these rows actually have order data? (One read for the block.)
  var data = sheet.getRange(firstRow, 1, numRows, DATA_LAST_COL).getValues();
  var stamp = Utilities.formatDate(new Date(), JHB_TZ, 'dd/MM/yyyy HH:mm');

  // Group the rows to stamp into contiguous runs so each run is written
  // with a single setValues call (fast even for a big paste).
  var runs = [];
  var runStart = null;
  var runEnd = null;
  for (var i = 0; i < numRows; i++) {
    var hasData = data[i].some(function (v) { return v !== '' && v !== null; });
    var r = firstRow + i;
    if (hasData) {
      if (runStart === null) { runStart = r; runEnd = r; }
      else if (r === runEnd + 1) { runEnd = r; }
      else { runs.push([runStart, runEnd]); runStart = r; runEnd = r; }
    }
  }
  if (runStart !== null) runs.push([runStart, runEnd]);

  runs.forEach(function (run) {
    var n = run[1] - run[0] + 1;
    var changedVals = [];
    var timeVals = [];
    for (var k = 0; k < n; k++) {
      changedVals.push(['changed']);
      timeVals.push([stamp]);
    }
    sheet.getRange(run[0], CHANGED_COL, n, 1).setValues(changedVals);
    sheet.getRange(run[0], CHANGED_AT_COL, n, 1).setValues(timeVals);
  });
}
