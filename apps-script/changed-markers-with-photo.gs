/**
 * Changed markers + photo — standalone script
 * ------------------------------------------------------------------
 * When a person CHANGES an existing value in columns A:K of a row on the
 * "Customer Order Details" tab (a cell that held a value was edited to
 * something else, or was deleted):
 *   column L  -> the word "changed"
 *   column M  -> date/time of the change
 *   column N  -> link to the photo of the person (when photos are switched on)
 * Typing into an EMPTY cell does not count. Editing L:N does not count either.
 *
 * Columns L:N are LOCKED: staff can see them but cannot edit them. ONLY
 * jonathankabango08@gmail.com and the ordering app's own Google account can
 * write there, so the app's manual orders / add-ons / customer orders keep working.
 * Everything else on the sheet stays editable by everyone it is shared with.
 *
 * Photos are saved in the Drive folder "Sheet Change Photos" which is set to
 * "anyone with the link can VIEW", so nobody has to ask for permission to see
 * a photo. (Viewing only — nobody can change or delete them.)
 *
 * The photo feature is switched by PHOTO_ENABLED below (true = on).
 */

var CHANGED_TZ = 'Africa/Johannesburg';
var CHANGED_COL = 12;      // L: the word "changed"
var CHANGED_AT_COL = 13;   // M: date/time of the change
var PHOTO_COL = 14;        // N: link to the photo
var DATA_LAST_COL = 11;    // K: last order-data column
var ORDER_TAB_NAME = 'Customer Order Details';
var PROTECT_DESC = 'Auto-filled by the system — please do not delete';

// The two order tabs. Edits on any other tab are ignored.
var ORDER_TAB_GIDS = [1049158606, 1026895194];

// Secret token the /camera page must send. Paste this same value into the
// camera page settings. (Change it here + in the camera page if it ever leaks.)
// Photo feature switch. true = photos ON, false = PAUSED (no photo requests are queued).
var PHOTO_ENABLED = true;

var CAMERA_TOKEN = 'bcfe967bcbeaabe8ff8e4339b57a91d2';

var QUEUE_TAB = '__photo_queue';
var SNAP_TAB = '__snapshot';        // hidden copy of A:K, used to know what a cell held BEFORE an edit
var PHOTO_FOLDER_NAME = 'Sheet Change Photos';
var MERGE_WINDOW_MS = 15 * 1000;     // edits within 15s share one photo
var MAX_AGE_MS = 5 * 60 * 1000;      // an edit older than 5 min is no longer photographed
var KEEP_QUEUE_MS = 24 * 60 * 60 * 1000;
var MAX_IMAGE_CHARS = 6 * 1024 * 1024; // refuse absurdly large uploads

// Queue columns (1-based): A id | B createdMs | C gid | D rows | E editor | F status | G claimedMs
var Q_ID = 1, Q_CREATED = 2, Q_GID = 3, Q_ROWS = 4, Q_EDITOR = 5, Q_STATUS = 6, Q_CLAIMED = 7;

// ============================== SETUP ==============================

/** Run ONCE per spreadsheet. Safe to run again. */
function setupChangedMarkers() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(ORDER_TAB_NAME);
  if (!sheet) {
    throw new Error('Could not find the "' + ORDER_TAB_NAME + '" tab in this spreadsheet. Run this in the MON-WED / THU-SAT order sheet project.');
  }

  // Headers
  sheet.getRange(1, CHANGED_COL).setValue('Changed');
  sheet.getRange(1, CHANGED_AT_COL).setValue('Changed At');
  sheet.getRange(1, PHOTO_COL).setValue('Photo');

  // Lock L:N: only Jonathan + the app's account can edit.
  sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (p) {
    if (p.getDescription() === PROTECT_DESC) p.remove();
  });
  var lastRow = Math.max(2000, sheet.getMaxRows());
  var protection = sheet.getRange(1, CHANGED_COL, lastRow, 3).protect();
  protection.setDescription(PROTECT_DESC);
  protection.setWarningOnly(false);
  applyProtectionEditors_(protection);
  Logger.log('Locked columns L:N (staff can view but not edit; only Jonathan and the app can).');

  if (PHOTO_ENABLED) {
    // Hidden queue tab
    var q = ss.getSheetByName(QUEUE_TAB);
    if (!q) {
      q = ss.insertSheet(QUEUE_TAB);
      q.appendRow(['id', 'createdMs', 'gid', 'rows', 'editor', 'status', 'claimedMs']);
    }
    q.hideSheet();

    // Drive folder for the photos (viewable by link)
    getPhotoFolder_();

    // Secret token for the camera page
    PropertiesService.getScriptProperties().setProperty('PHOTO_TOKEN', CAMERA_TOKEN);
  }

  // Edit trigger (runs as whoever runs this setup, for every editor)
  var has = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'markChangedOnEdit';
  });
  if (!has) {
    ScriptApp.newTrigger('markChangedOnEdit').forSpreadsheet(ss).onEdit().create();
    Logger.log('Edit trigger installed: markChangedOnEdit.');
  } else {
    Logger.log('Edit trigger already installed.');
  }

  // Hidden snapshot of A:K (so a deleted/overwritten selection can be compared with what it held before)
  refreshSnapshot();
  var hasSnap = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'refreshSnapshot';
  });
  if (!hasSnap) {
    ScriptApp.newTrigger('refreshSnapshot').timeBased().everyMinutes(1).create();
    Logger.log('Snapshot trigger installed: refreshSnapshot (every minute).');
  }

  Logger.log('Done. Changed markers are ON; L:N locked for staff; photos are ' + (PHOTO_ENABLED ? 'ON.' : 'PAUSED.'));
}

/**
 * Keeps ONLY these able to edit L:N:
 *   - the accounts in ALWAYS_ALLOWED (only Jonathan)
 *   - the ordering app's own Google account (an address ending in gserviceaccount.com)
 * Everyone else is removed. Run the setup while signed in as Jonathan.
 */
var ALWAYS_ALLOWED = ['jonathankabango08@gmail.com'];

function applyProtectionEditors_(protection) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var allowed = {};
  ALWAYS_ALLOWED.forEach(function (m) { allowed[String(m).toLowerCase()] = true; });

  var isApp = function (mail) { return /gserviceaccount\.com$/i.test(mail); };
  var kept = {};

  // 1) Remove everyone who is not allowed.
  protection.getEditors().forEach(function (u) {
    var mail = u.getEmail();
    if (allowed[mail.toLowerCase()] || isApp(mail)) kept[mail.toLowerCase()] = true;
    else { try { protection.removeEditor(u); } catch (err) { Logger.log('Could not remove ' + mail + ': ' + err); } }
  });

  // 2) Add whoever is allowed but missing (Jonathan + the app account).
  var toAdd = Object.keys(allowed);
  ss.getEditors().forEach(function (u) { if (isApp(u.getEmail())) toAdd.push(u.getEmail()); });
  toAdd.forEach(function (mail) {
    if (kept[mail.toLowerCase()]) return;
    try { protection.addEditor(mail); kept[mail.toLowerCase()] = true; }
    catch (err) { Logger.log('Could not add ' + mail + ' (is the sheet shared with them as Editor?): ' + err); }
  });

  var list = Object.keys(kept);
  Logger.log('Allowed to edit L:N: ' + list.join(', '));
  if (!list.some(isApp)) {
    Logger.log('WARNING: the app\'s service account (…@…gserviceaccount.com) is not an editor of this spreadsheet. ' +
      'Share the sheet with it as Editor, then run fixProtectionForApp.');
  }
}

/** RUN THIS if the app ever says "protected cell": re-allows Jonathan + the app's account. */
function fixProtectionForApp() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ORDER_TAB_NAME);
  if (!sheet) throw new Error('Tab "' + ORDER_TAB_NAME + '" not found.');
  var found = 0;
  sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (p) {
    if (p.getDescription() === PROTECT_DESC) { applyProtectionEditors_(p); found++; }
  });
  if (!found) Logger.log('No L:N lock found — run setupChangedMarkers instead.');
}

/**
 * Makes the photo folder and every photo in it viewable by anyone with the
 * link (view only). Run once; new photos are set automatically.
 */
function makePhotosViewable() {
  var folder = getPhotoFolder_();
  setViewable_(folder);
  var files = folder.getFiles();
  var n = 0;
  while (files.hasNext()) { setViewable_(files.next()); n++; }
  Logger.log('Photos folder + ' + n + ' photo(s) are now viewable by anyone with the link: ' + folder.getUrl());
}

function setViewable_(item) {
  try { item.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }
  catch (err) { Logger.log('Could not set sharing on ' + item.getName() + ': ' + err); }
}

/** Run any time to see the token again. */
function showPhotoToken() {
  Logger.log('SECRET TOKEN: ' + PropertiesService.getScriptProperties().getProperty('PHOTO_TOKEN'));
}

function getPhotoFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('PHOTO_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (err) { /* recreate below */ }
  }
  var folder = DriveApp.createFolder(PHOTO_FOLDER_NAME);
  setViewable_(folder);
  props.setProperty('PHOTO_FOLDER_ID', folder.getId());
  return folder;
}

// ============================ EDIT TRIGGER ============================

function norm_(v) { return String(v === null || v === undefined ? '' : v).trim(); }

/**
 * Installable onEdit trigger. A row is marked "changed" ONLY when, in columns
 * A:K, a cell that HELD a value was edited to something different (or was
 * deleted). Typing into an empty cell, or editing L:N, does nothing.
 * Programmatic writes (the app, the daily clear) don't fire this trigger.
 *
 * For one edited cell Google tells us the old value (e.oldValue). For several
 * cells at once (select + Delete, paste) it doesn't, so we compare with the
 * hidden "__snapshot" tab, which holds a copy of A:K.
 */
function markChangedOnEdit(e) {
  if (!e || !e.range) return;
  var sheet = e.range.getSheet();
  if (ORDER_TAB_GIDS.indexOf(sheet.getSheetId()) === -1) return;

  var startRow = e.range.getRow();
  var endRow = startRow + e.range.getNumRows() - 1;
  var startCol = e.range.getColumn();
  var endCol = startCol + e.range.getNumColumns() - 1;

  if (startCol > DATA_LAST_COL) return;              // only A:K counts
  var firstRow = Math.max(startRow, 2);              // never the header row
  if (firstRow > endRow) return;
  var lastCol = Math.min(endCol, DATA_LAST_COL);
  var numRows = endRow - firstRow + 1;
  var numCols = lastCol - startCol + 1;
  var single = e.range.getNumRows() === 1 && e.range.getNumColumns() === 1;

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var changedRows = [];
  try {
    var now = sheet.getRange(firstRow, startCol, numRows, numCols).getDisplayValues();
    var snap = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SNAP_TAB);
    var before = null;
    if (!single && snap && snap.getMaxRows() >= endRow) {
      before = snap.getRange(firstRow, startCol, numRows, numCols).getValues();
    }

    for (var i = 0; i < numRows; i++) {
      var rowChanged = false;
      for (var j = 0; j < numCols && !rowChanged; j++) {
        var oldV = single ? norm_(e.oldValue) : (before ? norm_(before[i][j]) : '');
        var newV = norm_(now[i][j]);
        if (oldV !== '' && oldV !== newV) rowChanged = true;   // had a value, now different/removed
      }
      if (rowChanged) changedRows.push(firstRow + i);
    }

    // Keep the snapshot up to date for the cells that were just edited.
    if (snap && snap.getMaxRows() >= endRow) {
      snap.getRange(firstRow, startCol, numRows, numCols).setNumberFormat('@').setValues(now);
    }
  } finally {
    lock.releaseLock();
  }
  if (!changedRows.length) return;

  // Write "changed" + time for the changed rows (grouped into runs).
  var stamp = Utilities.formatDate(new Date(), CHANGED_TZ, 'dd/MM/yyyy HH:mm');
  var runs = [];
  var runStart = changedRows[0], runEnd = changedRows[0];
  for (var k = 1; k < changedRows.length; k++) {
    if (changedRows[k] === runEnd + 1) runEnd = changedRows[k];
    else { runs.push([runStart, runEnd]); runStart = changedRows[k]; runEnd = changedRows[k]; }
  }
  runs.push([runStart, runEnd]);
  runs.forEach(function (run) {
    var n = run[1] - run[0] + 1;
    var changedVals = [], timeVals = [];
    for (var m = 0; m < n; m++) { changedVals.push(['changed']); timeVals.push([stamp]); }
    sheet.getRange(run[0], CHANGED_COL, n, 1).setValues(changedVals);
    sheet.getRange(run[0], CHANGED_AT_COL, n, 1).setValues(timeVals);
  });

  // (PAUSED unless PHOTO_ENABLED) Ask for a photo of whoever just made this change.
  if (PHOTO_ENABLED) {
    var editor = '';
    try { editor = (e.user && e.user.getEmail()) || ''; } catch (err) { editor = ''; }
    try {
      queuePhoto_(sheet.getSheetId(), changedRows.slice(0, 200), editor);
    } catch (err) {
      Logger.log('queuePhoto_ failed: ' + err);
    }
  }
}

// ============================== SNAPSHOT ==============================

/**
 * Copies columns A:K of the order tab into the hidden "__snapshot" tab so the
 * edit trigger knows what a cell held before it was deleted/overwritten.
 * Runs every minute (and once during setup). The app's own writes and the
 * daily clear are picked up here too.
 */
function refreshSnapshot() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(ORDER_TAB_NAME);
    if (!sheet) return;
    var rows = Math.min(sheet.getMaxRows(), Math.max(sheet.getLastRow(), 2) + 50);
    var vals = sheet.getRange(1, 1, rows, DATA_LAST_COL).getDisplayValues();

    var snap = ss.getSheetByName(SNAP_TAB);
    if (!snap) {
      snap = ss.insertSheet(SNAP_TAB);
      snap.hideSheet();
    }
    if (snap.getMaxColumns() < DATA_LAST_COL) snap.insertColumnsAfter(snap.getMaxColumns(), DATA_LAST_COL - snap.getMaxColumns());
    if (snap.getMaxRows() < sheet.getMaxRows()) snap.insertRowsAfter(snap.getMaxRows(), sheet.getMaxRows() - snap.getMaxRows());

    var old = snap.getRange(1, 1, rows, DATA_LAST_COL).getValues();
    var same = true;
    for (var i = 0; i < rows && same; i++) {
      for (var j = 0; j < DATA_LAST_COL; j++) {
        if (norm_(old[i][j]) !== norm_(vals[i][j])) { same = false; break; }
      }
    }
    if (same) return;
    var all = snap.getRange(1, 1, snap.getMaxRows(), DATA_LAST_COL);
    all.clearContent();
    all.setNumberFormat('@');                 // plain text so "007" stays "007"
    snap.getRange(1, 1, rows, DATA_LAST_COL).setValues(vals);
  } finally {
    lock.releaseLock();
  }
}

// =============================== QUEUE ================================

function getQueueSheet_() {
  var q = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(QUEUE_TAB);
  if (!q) throw new Error('Queue tab missing — run setupChangedMarkers once.');
  return q;
}

function queuePhoto_(gid, rows, editor) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var q = getQueueSheet_();
    var now = Date.now();
    var last = q.getLastRow();

    // Housekeeping: drop rows older than a day (keeps the queue tiny).
    if (last >= 2) {
      var all = q.getRange(2, 1, last - 1, 7).getValues();
      var keep = all.filter(function (r) { return now - Number(r[Q_CREATED - 1]) < KEEP_QUEUE_MS; });
      if (keep.length !== all.length) {
        q.getRange(2, 1, last - 1, 7).clearContent();
        if (keep.length) q.getRange(2, 1, keep.length, 7).setValues(keep);
        last = 1 + keep.length;
      }
    }

    // Merge into the newest pending request if it's very recent (same person,
    // same tab) — a burst of edits shares one photo instead of dozens.
    if (last >= 2) {
      var rec = q.getRange(last, 1, 1, 7).getValues()[0];
      var sameTab = Number(rec[Q_GID - 1]) === gid;
      var sameEditor = String(rec[Q_EDITOR - 1]) === editor;
      var fresh = now - Number(rec[Q_CREATED - 1]) <= MERGE_WINDOW_MS;
      if (rec[Q_STATUS - 1] === 'pending' && sameTab && sameEditor && fresh) {
        var set = {};
        String(rec[Q_ROWS - 1]).split(',').forEach(function (x) { if (x) set[x] = true; });
        rows.forEach(function (x) { set[String(x)] = true; });
        q.getRange(last, Q_ROWS).setValue(Object.keys(set).join(','));
        return;
      }
    }

    q.appendRow([Utilities.getUuid(), now, gid, rows.join(','), editor, 'pending', '']);
  } finally {
    lock.releaseLock();
  }
}

// ============================ WEB ENDPOINT ============================

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function tokenOk_(t) {
  var real = PropertiesService.getScriptProperties().getProperty('PHOTO_TOKEN');
  return !!real && !!t && String(t) === real;
}

/** GET ?action=ping|take&token=...&email=... */
function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    if (!tokenOk_(p.token)) return json_({ ok: false, error: 'bad token' });
    if (p.action === 'ping') return json_({ ok: true, pong: true });
    if (p.action === 'take') return json_({ ok: true, item: takeNext_(String(p.email || '')) });
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/** POST (text/plain JSON) {action:'upload', token, id, image} */
function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!tokenOk_(body.token)) return json_({ ok: false, error: 'bad token' });
    if (body.action === 'upload') return json_(saveUpload_(body));
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/** Hands the oldest still-fresh pending request to the camera page. */
function takeNext_(email) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var q = getQueueSheet_();
    var last = q.getLastRow();
    if (last < 2) return null;
    var now = Date.now();
    var recs = q.getRange(2, 1, last - 1, 7).getValues();
    var mail = email.toLowerCase();
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i];
      if (r[Q_STATUS - 1] !== 'pending') continue;
      var age = now - Number(r[Q_CREATED - 1]);
      if (age > MAX_AGE_MS) {
        q.getRange(i + 2, Q_STATUS).setValue('expired');
        continue;
      }
      // Give a request only to the matching person's camera when we know both.
      var editor = String(r[Q_EDITOR - 1]).toLowerCase();
      if (mail && editor && mail !== editor) continue;
      // Short pause so the edit has settled (and quick follow-up edits can join it).
      if (age < 3000) continue;
      q.getRange(i + 2, Q_STATUS).setValue('claimed');
      q.getRange(i + 2, Q_CLAIMED).setValue(now);
      return {
        id: String(r[Q_ID - 1]),
        gid: Number(r[Q_GID - 1]),
        rows: String(r[Q_ROWS - 1]).split(',').filter(String).map(Number)
      };
    }
    return null;
  } finally {
    lock.releaseLock();
  }
}

/** Saves the photo to Drive and writes the link in column N of the rows. */
function saveUpload_(body) {
  var id = String(body.id || '');
  var image = String(body.image || '');
  if (!id || !image) return { ok: false, error: 'missing id/image' };
  if (image.length > MAX_IMAGE_CHARS) return { ok: false, error: 'image too large' };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  var rec = null, rowIndex = -1, q;
  try {
    q = getQueueSheet_();
    var last = q.getLastRow();
    if (last < 2) return { ok: false, error: 'queue empty' };
    var recs = q.getRange(2, 1, last - 1, 7).getValues();
    for (var i = 0; i < recs.length; i++) {
      if (String(recs[i][Q_ID - 1]) === id) { rec = recs[i]; rowIndex = i + 2; break; }
    }
    if (!rec) return { ok: false, error: 'unknown request' };
    if (rec[Q_STATUS - 1] !== 'claimed') return { ok: false, error: 'request not claimed (' + rec[Q_STATUS - 1] + ')' };
    q.getRange(rowIndex, Q_STATUS).setValue('saving');
  } finally {
    lock.releaseLock();
  }

  try {
    var b64 = image.replace(/^data:image\/[a-zA-Z+]+;base64,/, '');
    var editor = String(rec[Q_EDITOR - 1]) || 'unknown';
    var when = Utilities.formatDate(new Date(), CHANGED_TZ, 'yyyy-MM-dd HH-mm-ss');
    var blob = Utilities.newBlob(Utilities.base64Decode(b64), 'image/jpeg', 'change ' + when + ' - ' + editor + '.jpg');
    var file = getPhotoFolder_().createFile(blob);
    setViewable_(file); // anyone with the link can VIEW (not edit)
    var url = 'https://drive.google.com/file/d/' + file.getId() + '/view';

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var gid = Number(rec[Q_GID - 1]);
    var sheet = ss.getSheets().filter(function (s) { return s.getSheetId() === gid; })[0];
    if (sheet) {
      String(rec[Q_ROWS - 1]).split(',').filter(String).forEach(function (r) {
        sheet.getRange(Number(r), PHOTO_COL).setFormula('=HYPERLINK("' + url + '","📷 photo")');
      });
    }
    q.getRange(rowIndex, Q_STATUS).setValue('done');
    return { ok: true, url: url };
  } catch (err) {
    q.getRange(rowIndex, Q_STATUS).setValue('failed');
    return { ok: false, error: String(err) };
  }
}
